// [SPEC:WSF-6] specs/064-watch-single-file-conflict/contracts/watch-single-file-sync.md (C-4)
//
// C-4: after a successful upload, the FileState must satisfy
//   localHash === remoteId && idType === 'sha256' && isConflicted === false
// so that the immediately-following sync is a pure no-op (no download, no upload).
//
// Bug being guarded against: uploadFile used to record the PRE-upload remoteId (the value observed
// before the PUT) instead of the hash of what was just uploaded. Nextcloud returns the uploaded
// content's SHA-256 as the checksum on the next listing (both upload strategies send an
// `OC-Checksum: SHA256:<hash>` header, which the server persists and echoes back). Recording the
// stale pre-upload id therefore made every subsequent sync see "remote changed" and re-download the
// very file this device had just uploaded — an infinite thrash loop (SC-005 regression).
//
// This test drives the REAL SyncEngine.processRemoteFile (the same classifier full sync and watch
// mode both call) rather than re-implementing the classification/upload logic locally.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';

const enc = new TextEncoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';

function makeStateAdapter(): DataAdapter {
  const store: Record<string, string> = {};
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (f: string, t: string) => { store[t] = store[f]; delete store[f]; }),
    stat: jest.fn(), list: jest.fn(), readBinary: jest.fn(), writeBinary: jest.fn(),
  } as unknown as DataAdapter;
}

function makeSummary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

/** In-memory local vault, matching the pattern used by untrackedBothSides.test.ts. */
function makeLocalAdapter(files: Record<string, string>, mtimes: Record<string, number> = {}) {
  const mtimeOf = (p: string): number => mtimes[p] ?? 1_000;
  return {
    files,
    stat: jest.fn(async (p: string) =>
      p in files ? { size: enc.encode(files[p]).length, mtime: mtimeOf(p) } : null),
    exists: jest.fn(async (p: string) => p in files),
    read: jest.fn(async (p: string) => files[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(files[p] ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    atomicWriteBinary: jest.fn(async () => undefined),
    writeBinary: jest.fn(async () => undefined),
    setMtime: jest.fn(),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
  };
}

async function buildEngine(
  localAdapter: Record<string, unknown>,
  client: Record<string, unknown>,
  upload: jest.Mock,
) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const baseStore = {
    get: jest.fn(() => undefined), set: jest.fn(), delete: jest.fn(),
    requestSave: jest.fn(), flush: jest.fn(async () => undefined),
  };
  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS },
    localAdapter, stateDB, baseStore, statusBar: {}, webdavFactory: {},
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);
  (engine as unknown as { client: unknown }).client = client;
  (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = { upload };
  return { engine, stateDB };
}

const callProcessRemote = (e: SyncEngine, r: RemoteFileInfo, s: SyncSessionSummary) =>
  (e as unknown as {
    processRemoteFile: (r: RemoteFileInfo, s: SyncSessionSummary) => Promise<void>;
  }).processRemoteFile(r, s);

const remoteOf = (path: string, body: string, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo =>
  ({
    path, fileId: 'f1', checksum: null, etag: 'remote-etag',
    size: enc.encode(body).length, lastModified: 9_000, ...over,
  });

describe('[SPEC:WSF-6] uploaded FileState converges instead of re-downloading (C-4)', () => {
  it('[SPEC:WSF-6] records localHash === remoteId (sha256, not conflicted) right after a successful upload', async () => {
    const OLD = 'v1\n';
    const EDITED = 'v1 plus a local edit\n';
    const oldHash = await sha256(toBuf(OLD));
    const newHash = await sha256(toBuf(EDITED));

    const local = makeLocalAdapter({ 'note.md': EDITED }, { 'note.md': 5_000 });
    const upload = jest.fn(async () => 'uploaded' as const);
    const client = { downloadFile: jest.fn(async () => toBuf(OLD)) };
    const { engine, stateDB } = await buildEngine(local, client, upload);

    // Baseline: this device previously synced OLD, and the server still holds OLD (unchanged).
    stateDB.setFile({
      path: 'note.md', localHash: oldHash, remoteId: oldHash, idType: 'sha256',
      size: enc.encode(OLD).length, mtime: 1_000, remoteFileId: 'f1', isConflicted: false,
    });

    const summary = makeSummary();
    // Remote still reports the OLD checksum (matches base) — only the local side changed.
    await callProcessRemote(engine, remoteOf('note.md', OLD, { checksum: oldHash }), summary);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(summary.uploadedCount).toBe(1);

    const state = stateDB.getFile('note.md');
    expect(state).toBeDefined();
    // C-4: the state records what the server now holds (the just-uploaded content's hash), not the
    // pre-upload remoteId — this is the exact assertion the pre-fix code violated.
    expect(state!.localHash).toBe(newHash);
    expect(state!.remoteId).toBe(newHash);
    expect(state!.localHash).toBe(state!.remoteId);
    expect(state!.idType).toBe('sha256');
    expect(state!.isConflicted).toBe(false);
  });

  it('[SC-005] a second sync right after the upload triggers neither a download nor another upload', async () => {
    const OLD = 'v1\n';
    const EDITED = 'v1 plus a local edit\n';
    const oldHash = await sha256(toBuf(OLD));
    const newHash = await sha256(toBuf(EDITED));

    const local = makeLocalAdapter({ 'note.md': EDITED }, { 'note.md': 5_000 });
    const upload = jest.fn(async () => 'uploaded' as const);
    const client = { downloadFile: jest.fn(async () => toBuf(OLD)) };
    const { engine, stateDB } = await buildEngine(local, client, upload);

    stateDB.setFile({
      path: 'note.md', localHash: oldHash, remoteId: oldHash, idType: 'sha256',
      size: enc.encode(OLD).length, mtime: 1_000, remoteFileId: 'f1', isConflicted: false,
    });

    await callProcessRemote(engine, remoteOf('note.md', OLD, { checksum: oldHash }), makeSummary());
    expect(upload).toHaveBeenCalledTimes(1);

    // Real Nextcloud behaviour: the PUT sent `OC-Checksum: SHA256:<newHash>`, so the very next
    // PROPFIND/listing reports the uploaded content's own hash as the checksum.
    const secondSummary = makeSummary();
    await callProcessRemote(engine, remoteOf('note.md', EDITED, { checksum: newHash }), secondSummary);

    // Neither side needs to move any bytes: local is still EDITED, remote already reports newHash.
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(1); // still just the one call from the first sync
    expect(secondSummary.downloadedCount).toBe(0);
    expect(secondSummary.uploadedCount).toBe(0);
    expect(secondSummary.mergedCount + secondSummary.conflictedCount).toBe(0);

    const state = stateDB.getFile('note.md');
    expect(state!.isConflicted).toBe(false);
    expect(local.files['note.md']).toBe(EDITED); // untouched
  });
});
