// REGRESSION: SyncEngine.deleteSingleFile / deleteSingleFolder must NOT drop the StateDB tracking entry when
// the remote delete genuinely fails (423/500/timeout; a 404 is treated as success by NextcloudClient).
// Dropping it makes the next sync see base=undefined for a file/folder STILL on the server, read it as
// "new remote" and re-download it, silently reverting the user's local deletion.
// deleteSingleFile stats the remote first and delegates to the same guarded delete as the full sync
// (applyLocalDeletion), so the doubles must answer `statFile`. The remote carries a checksum EQUAL to the
// base localHash, the only case where a deletion may propagate at all.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { FileState, DirState, RemoteFileInfo } from '../../../src/types';

// Remote state whose checksum matches `hash` (unchanged since our base), so deletion is allowed.
const unchangedRemote = (path: string, hash: string): RemoteFileInfo => ({
  path, fileId: null, checksum: hash, etag: 'e1', size: 1, lastModified: 1,
});

function makeFileEngine(base: FileState) {
  const files = new Map<string, FileState>([[base.path, base]]);
  const deleteFile = jest.fn(async () => { throw new Error('500 Internal Server Error'); });
  const statFile = jest.fn(async (p: string) => unchangedRemote(p, base.localHash));
  const stateDB = {
    getFile: (p: string) => files.get(p),
    deleteFile: jest.fn((p: string) => { files.delete(p); }),
    requestSave: jest.fn(),
  };
  const engine = new SyncEngine({
    app: {}, settings: {}, localAdapter: {}, stateDB, statusBar: { setStatus: jest.fn() },
    webdavFactory: { createClient: jest.fn(async () => ({ client: { deleteFile, statFile }, features: {} })) },
    pluginDir: '', configDir: '.obsidian',
  } as never);
  return { engine, files, stateDB, deleteFile, statFile };
}

function makeFolderEngine(dir: DirState) {
  const dirs = new Map<string, DirState>([[dir.path, dir]]);
  const deleteCollection = jest.fn(async () => { throw new Error('500 Internal Server Error'); });
  const stateDB = {
    getDir: (p: string) => dirs.get(p),
    deleteDir: jest.fn((p: string) => { dirs.delete(p); }),
    requestSave: jest.fn(),
  };
  const engine = new SyncEngine({
    app: {}, settings: {}, localAdapter: {}, stateDB, statusBar: { setStatus: jest.fn() },
    webdavFactory: { createClient: jest.fn(async () => ({ client: { deleteCollection }, features: {} })) },
    pluginDir: '', configDir: '.obsidian',
  } as never);
  return { engine, dirs, stateDB, deleteCollection };
}

const fileState = (path: string): FileState => ({
  path, localHash: 'h1', remoteId: 'r1', idType: 'sha256', size: 1, mtime: 1,
  remoteFileId: null, isConflicted: false,
});

describe('[SPEC:G1-2] SyncEngine.deleteSingleFile — remote delete failure must not drop tracking', () => {
  it('keeps the StateDB entry when the remote DELETE fails (real failure, not 404)', async () => {
    const { engine, files, stateDB } = makeFileEngine(fileState('Notes/gone.md'));

    await engine.deleteSingleFile('Notes/gone.md');

    // The tracking entry must survive so the next sync retries the delete instead of reading base=undefined
    // and re-downloading the still-present remote file.
    expect(files.has('Notes/gone.md')).toBe(true);
    expect(stateDB.deleteFile).not.toHaveBeenCalled();
  });

  it('drops the StateDB entry when the remote DELETE succeeds', async () => {
    const files = new Map<string, FileState>([['Notes/gone.md', fileState('Notes/gone.md')]]);
    const deleteFile = jest.fn(async () => undefined);
    const statFile = jest.fn(async (p: string) => unchangedRemote(p, 'h1'));
    const stateDB = {
      getFile: (p: string) => files.get(p),
      deleteFile: jest.fn((p: string) => { files.delete(p); }),
      requestSave: jest.fn(),
    };
    const engine = new SyncEngine({
      app: {}, settings: {}, localAdapter: {}, stateDB, statusBar: { setStatus: jest.fn() },
      webdavFactory: { createClient: jest.fn(async () => ({ client: { deleteFile, statFile }, features: {} })) },
      pluginDir: '', configDir: '.obsidian',
    } as never);

    await engine.deleteSingleFile('Notes/gone.md');

    expect(files.has('Notes/gone.md')).toBe(false);
    expect(stateDB.deleteFile).toHaveBeenCalledWith('Notes/gone.md');
  });
});

describe('[SPEC:G1-2] SyncEngine.deleteSingleFolder — remote delete failure must not drop tracking', () => {
  it('keeps the tracked directory when the remote collection DELETE fails', async () => {
    const { engine, dirs, stateDB } = makeFolderEngine({ path: 'Old', remoteFileId: null });

    await engine.deleteSingleFolder('Old');

    expect(dirs.has('Old')).toBe(true);
    expect(stateDB.deleteDir).not.toHaveBeenCalled();
  });

  it('drops the tracked directory when the remote collection DELETE succeeds', async () => {
    const dirs = new Map<string, DirState>([['Old', { path: 'Old', remoteFileId: null }]]);
    const deleteCollection = jest.fn(async () => undefined);
    const stateDB = {
      getDir: (p: string) => dirs.get(p),
      deleteDir: jest.fn((p: string) => { dirs.delete(p); }),
      requestSave: jest.fn(),
    };
    const engine = new SyncEngine({
      app: {}, settings: {}, localAdapter: {}, stateDB, statusBar: { setStatus: jest.fn() },
      webdavFactory: { createClient: jest.fn(async () => ({ client: { deleteCollection }, features: {} })) },
      pluginDir: '', configDir: '.obsidian',
    } as never);

    await engine.deleteSingleFolder('Old');

    expect(dirs.has('Old')).toBe(false);
    expect(stateDB.deleteDir).toHaveBeenCalledWith('Old');
  });
});
