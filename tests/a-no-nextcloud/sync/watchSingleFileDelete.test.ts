// [SPEC:WSF-5] specs/064-watch-single-file-conflict/contracts/watch-single-file-sync.md (C-2)
//
// Feature 064 (C-2, rows 2-6): SyncEngine.deleteSingleFile (watch-mode single-file delete) used to
// issue an unconditional remote DELETE, so a note another device had just edited was removed anyway.
// It now delegates to applyLocalDeletion — the SAME server-side-checksum guard the full sync uses —
// via a Depth:0 statFile() lookup. These tests drive the REAL engine.deleteSingleFile, not a
// reimplementation of the classification, against doubles for the WebDAV client, StateDB, and the
// local vault.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS, FileState, RemoteFileInfo } from '../../../src/types';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;

const fileState = (path: string, hash: string): FileState => ({
  path, localHash: hash, remoteId: hash, idType: 'sha256', size: 1, mtime: 1,
  remoteFileId: 'f1', isConflicted: false,
});

/** Minimal StateDB double: only the surface deleteSingleFile / applyLocalDeletion touch. */
function makeStateDB(seed?: FileState) {
  const files = new Map<string, FileState>();
  if (seed) files.set(seed.path, seed);
  return {
    files,
    getFile: jest.fn((p: string) => files.get(p)),
    setFile: jest.fn((fs: FileState) => { files.set(fs.path, fs); }),
    deleteFile: jest.fn((p: string) => { files.delete(p); }),
    requestSave: jest.fn(),
  };
}

/** Minimal local-vault double: only the surface applyLocalDeletion's restore (download) path touches. */
function makeLocalAdapter(seedContent: Record<string, string> = {}) {
  const files: Record<string, string> = { ...seedContent };
  return {
    files,
    stat: jest.fn(async (p: string) =>
      (p in files ? { size: enc.encode(files[p]).length, mtime: 1_000 } : null)),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    setMtime: jest.fn(async () => undefined),
  };
}

function makeEngine(
  stateDB: ReturnType<typeof makeStateDB>,
  localAdapter: ReturnType<typeof makeLocalAdapter>,
  client: Record<string, unknown>,
): SyncEngine {
  return new SyncEngine({
    app: {}, settings: DEFAULT_SETTINGS, localAdapter, stateDB,
    statusBar: { setStatus: jest.fn() },
    webdavFactory: { createClient: jest.fn(async () => ({ client, features: {} })) },
    pluginDir: '', configDir: '.obsidian',
  } as never);
}

describe('[SPEC:WSF-5] SyncEngine.deleteSingleFile — C-2 deletion classification', () => {
  it('C-2 row 2: an untracked path (no base) is a no-op — statFile is never called', async () => {
    const stateDB = makeStateDB(); // no seed => untracked
    const localAdapter = makeLocalAdapter();
    const statFile = jest.fn(async () => null);
    const deleteFile = jest.fn(async () => undefined);
    const engine = makeEngine(stateDB, localAdapter, { statFile, deleteFile });

    await engine.deleteSingleFile('Notes/untracked.md');

    expect(statFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    expect(stateDB.deleteFile).not.toHaveBeenCalled();
  });

  it('C-2 row 3: remote already absent (statFile -> null) — no DELETE, tracking dropped', async () => {
    const stateDB = makeStateDB(fileState('Notes/gone.md', 'h1'));
    const localAdapter = makeLocalAdapter();
    const statFile = jest.fn(async () => null);
    const deleteFile = jest.fn(async () => undefined);
    const engine = makeEngine(stateDB, localAdapter, { statFile, deleteFile });

    await engine.deleteSingleFile('Notes/gone.md');

    expect(statFile).toHaveBeenCalledWith('Notes/gone.md');
    expect(deleteFile).not.toHaveBeenCalled();
    expect(stateDB.deleteFile).toHaveBeenCalledWith('Notes/gone.md');
    expect(stateDB.files.has('Notes/gone.md')).toBe(false);
  });

  it('C-2 row 4: server checksum matches base — remote is deleted and tracking is dropped', async () => {
    const stateDB = makeStateDB(fileState('Notes/synced.md', 'h1'));
    const localAdapter = makeLocalAdapter();
    const remote: RemoteFileInfo = {
      path: 'Notes/synced.md', fileId: 'f1', checksum: 'h1', etag: 'e1', size: 3, lastModified: 1,
    };
    const statFile = jest.fn(async () => remote);
    const deleteFile = jest.fn(async () => undefined);
    const engine = makeEngine(stateDB, localAdapter, { statFile, deleteFile });

    await engine.deleteSingleFile('Notes/synced.md');

    expect(deleteFile).toHaveBeenCalledWith('Notes/synced.md', 'h1');
    expect(stateDB.files.has('Notes/synced.md')).toBe(false);
  });

  it('C-2 row 5: server checksum diverged from base — deletion refused and remote content is restored locally', async () => {
    const stateDB = makeStateDB(fileState('Notes/edited-elsewhere.md', 'h1'));
    const localAdapter = makeLocalAdapter(); // the local file is already gone -- that is what triggered the delete
    const REMOTE_BODY = 'edited on the other device just before this delete\n';
    const remote: RemoteFileInfo = {
      path: 'Notes/edited-elsewhere.md', fileId: 'f1', checksum: 'h2-different-from-base',
      etag: 'e2', size: enc.encode(REMOTE_BODY).length, lastModified: 5_000,
    };
    const statFile = jest.fn(async () => remote);
    const deleteFile = jest.fn(async () => undefined);
    const downloadFile = jest.fn(async () => toBuf(REMOTE_BODY));
    const engine = makeEngine(stateDB, localAdapter, { statFile, deleteFile, downloadFile });

    await engine.deleteSingleFile('Notes/edited-elsewhere.md');

    // The data-safety guarantee under test: the remote copy is NOT deleted...
    expect(deleteFile).not.toHaveBeenCalled();
    // ...its content is restored locally instead of letting the delete win...
    expect(downloadFile).toHaveBeenCalledWith('Notes/edited-elsewhere.md');
    expect(localAdapter.files['Notes/edited-elsewhere.md']).toBe(REMOTE_BODY);
    // ...and the file stays tracked (as a converged file, pointing at the restored content).
    expect(stateDB.deleteFile).not.toHaveBeenCalled();
    expect(stateDB.files.has('Notes/edited-elsewhere.md')).toBe(true);
  });

  it('C-2 row 6: server checksum unavailable (no ETag checksum, recalcChecksum fails) — deletion skipped, both sides untouched', async () => {
    const stateDB = makeStateDB(fileState('Notes/unknown.md', 'h1'));
    const localAdapter = makeLocalAdapter();
    const remote: RemoteFileInfo = {
      path: 'Notes/unknown.md', fileId: 'f1', checksum: null, etag: 'e3', size: 5, lastModified: 1,
    };
    const statFile = jest.fn(async () => remote);
    const deleteFile = jest.fn(async () => undefined);
    const downloadFile = jest.fn(async () => toBuf('must not be fetched'));
    const recalcChecksum = jest.fn(async () => null); // server cannot prove the copy is unchanged
    const engine = makeEngine(stateDB, localAdapter, {
      statFile, deleteFile, downloadFile, recalcChecksum,
    });

    await engine.deleteSingleFile('Notes/unknown.md');

    expect(recalcChecksum).toHaveBeenCalledWith('Notes/unknown.md');
    // Safe-side: neither branch of applyLocalDeletion runs when the checksum cannot be established.
    expect(deleteFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(stateDB.deleteFile).not.toHaveBeenCalled();
    expect(stateDB.setFile).not.toHaveBeenCalled();
    // Both sides are left exactly as they were, to be re-evaluated on the next full sync.
    expect(stateDB.files.get('Notes/unknown.md')).toEqual(fileState('Notes/unknown.md', 'h1'));
  });
});
