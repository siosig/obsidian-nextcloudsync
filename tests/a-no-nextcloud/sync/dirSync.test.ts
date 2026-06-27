// Directory reconciliation (DP) — SyncEngine.reconcileDirectories orchestration logic.
// Directories are first-class entities, symmetric with files: create/delete propagate by
// existence diff against the tracked set — an empty directory is preserved, never auto-pruned.
// Maximal combination coverage (CLAUDE.md 設計方針: tests maximised): every quadrant of
// {local, remote, tracked}, create/delete ordering, system exclusion, circuit breaker, the
// fileLockingEnabled gate, the delete-time empty probe, and self-healing on failure.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { TFolder } from '../support/obsidian';
import { DavSyncSettings, DirState, RemoteDirInfo, SyncSessionSummary } from '../../../src/types';

const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;

function makeSummary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
    deletedCount: 0, mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

function settings(over: Partial<DavSyncSettings> = {}): DavSyncSettings {
  return {
    configDir: CONFIG_DIR, syncConfigFolder: false,
    configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
    ...over,
  } as unknown as DavSyncSettings;
}

interface MockClient {
  getDirectories: jest.Mock;
  createDirectory: jest.Mock;
  deleteCollection: jest.Mock;
  isRemoteDirEmpty: jest.Mock;
  lockFile: jest.Mock;
  unlockFile: jest.Mock;
}

const rdir = (path: string): RemoteDirInfo => ({ path, fileId: `id-${path}`, etag: null, lastModified: 0 });

function makeClient(over: {
  remoteDirs?: string[];
  emptyOf?: (p: string) => boolean;
  deleteImpl?: (p: string) => Promise<void>;
} = {}): MockClient {
  return {
    getDirectories: jest.fn(async () => (over.remoteDirs ?? []).map(rdir)),
    createDirectory: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async (p: string) => { if (over.deleteImpl) await over.deleteImpl(p); }),
    isRemoteDirEmpty: jest.fn(async (p: string) => (over.emptyOf ? over.emptyOf(p) : true)),
    lockFile: jest.fn(async () => 'files_lock/tok'),
    unlockFile: jest.fn(async () => undefined),
  };
}

function makeEngine(opts: {
  client: MockClient;
  settings?: DavSyncSettings;
  localDirs?: string[];
  tracked?: DirState[];
  hasFilesLocking?: boolean;
}): { engine: SyncEngine; mkdir: jest.Mock; trashFile: jest.Mock; setDir: jest.Mock; deleteDir: jest.Mock } {
  const mkdir = jest.fn(async () => undefined);
  const adapter = {
    list: jest.fn(async () => ({ files: [], folders: [] })),
    readBinary: jest.fn(async () => new ArrayBuffer(0)),
    stat: jest.fn(async () => null),
    exists: jest.fn(async () => false),
    mkdir,
  };
  const localPaths = opts.localDirs ?? [];
  const trashFile = jest.fn(async () => undefined);
  const vault = {
    adapter,
    getFiles: () => [],
    getAllFolders: () => localPaths.map((p) => new TFolder(p)),
    getAbstractFileByPath: (p: string) => (localPaths.includes(p) ? new TFolder(p) : null),
    trash: jest.fn(),
  };
  const app = { vault, fileManager: { trashFile } };
  const setDir = jest.fn();
  const deleteDir = jest.fn();
  const stateDB = {
    getAllFiles: () => [], getFile: () => undefined,
    getAllDirs: () => opts.tracked ?? [], setDir, deleteDir,
  };
  const engine = new SyncEngine({
    app, settings: opts.settings ?? settings(), localAdapter: adapter,
    stateDB, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
  } as never);
  (engine as unknown as { client: MockClient }).client = opts.client;
  (engine as unknown as { features: unknown }).features = { hasFilesLocking: opts.hasFilesLocking ?? true };
  return { engine, mkdir, trashFile, setDir, deleteDir };
}

const dirState = (path: string): DirState => ({ path, remoteFileId: `id-${path}` });

const reconcile = (engine: SyncEngine, summary: SyncSessionSummary): Promise<void> =>
  (engine as unknown as { reconcileDirectories(s: SyncSessionSummary): Promise<void> }).reconcileDirectories(summary);

describe('SyncEngine.reconcileDirectories — directory create/delete propagation (DP)', () => {
  it('DP-1 local-only & untracked → MKCOL on the remote (empty directory is created, not pruned)', async () => {
    const client = makeClient({ remoteDirs: [] });
    const { engine, setDir } = makeEngine({ client, localDirs: ['newdir'] });
    await reconcile(engine, makeSummary());
    expect(client.createDirectory).toHaveBeenCalledWith('newdir');
    expect(setDir).toHaveBeenCalledWith({ path: 'newdir', remoteFileId: null });
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('DP-2 remote-only & untracked → mkdir locally', async () => {
    const client = makeClient({ remoteDirs: ['fromB'] });
    const { engine, mkdir, setDir } = makeEngine({ client, localDirs: [] });
    await reconcile(engine, makeSummary());
    expect(mkdir).toHaveBeenCalledWith('fromB');
    expect(setDir).toHaveBeenCalledWith({ path: 'fromB', remoteFileId: 'id-fromB' });
  });

  it('DP-3 tracked & local-absent (remote present) → DELETE the remote collection (user deleted it here)', async () => {
    const client = makeClient({ remoteDirs: ['gone'] });
    const { engine, deleteDir } = makeEngine({ client, localDirs: [], tracked: [dirState('gone')] });
    await reconcile(engine, makeSummary());
    expect(client.isRemoteDirEmpty).toHaveBeenCalledWith('gone');
    expect(client.deleteCollection).toHaveBeenCalledWith('gone');
    expect(deleteDir).toHaveBeenCalledWith('gone');
  });

  it('DP-4 tracked & remote-absent (local present) → trash locally (deleted on another device)', async () => {
    const client = makeClient({ remoteDirs: [] });
    const { engine, trashFile, deleteDir } = makeEngine({ client, localDirs: ['gone'], tracked: [dirState('gone')] });
    await reconcile(engine, makeSummary());
    expect(trashFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'gone' }));
    expect(deleteDir).toHaveBeenCalledWith('gone');
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('DP-5 present both sides → keep tracking, no create/delete', async () => {
    const client = makeClient({ remoteDirs: ['both'] });
    const { engine, setDir } = makeEngine({ client, localDirs: ['both'] });
    await reconcile(engine, makeSummary());
    expect(setDir).toHaveBeenCalledWith({ path: 'both', remoteFileId: 'id-both' });
    expect(client.createDirectory).not.toHaveBeenCalled();
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('DP-6 absent both sides but tracked → drop stale tracking', async () => {
    const client = makeClient({ remoteDirs: [] });
    const { engine, deleteDir } = makeEngine({ client, localDirs: [], tracked: [dirState('stale')] });
    await reconcile(engine, makeSummary());
    expect(deleteDir).toHaveBeenCalledWith('stale');
    expect(client.createDirectory).not.toHaveBeenCalled();
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('DP-7 never creates or deletes a system-excluded directory', async () => {
    const client = makeClient({ remoteDirs: [`${CONFIG_DIR}/themes`] });
    const { engine } = makeEngine({ client, localDirs: [`${CONFIG_DIR}/snippets`] });
    await reconcile(engine, makeSummary());
    expect(client.createDirectory).not.toHaveBeenCalled();
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('DP-8 create ordering: parents before children (MKCOL shallow-first)', async () => {
    const client = makeClient({ remoteDirs: [] });
    const { engine } = makeEngine({ client, localDirs: ['a/b/c', 'a', 'a/b'] });
    await reconcile(engine, makeSummary());
    expect(client.createDirectory.mock.calls.map((c) => c[0])).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it('DP-9 delete ordering: children before parents (deep-first)', async () => {
    const client = makeClient({ remoteDirs: ['a', 'a/b', 'a/b/c'] });
    const { engine } = makeEngine({ client, localDirs: [], tracked: [dirState('a'), dirState('a/b'), dirState('a/b/c')] });
    await reconcile(engine, makeSummary());
    expect(client.deleteCollection.mock.calls.map((c) => c[0])).toEqual(['a/b/c', 'a/b', 'a']);
  });

  it('DP-10 data-loss guard: a remote dir that probes non-empty at delete time is not deleted', async () => {
    const client = makeClient({ remoteDirs: ['gone'], emptyOf: () => false });
    const { engine } = makeEngine({ client, localDirs: [], tracked: [dirState('gone')] });
    await reconcile(engine, makeSummary());
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('DP-11 circuit breaker: refuses a suspiciously large delete batch but still applies creations', async () => {
    const tracked = Array.from({ length: 25 }, (_, i) => dirState(`d${i}`)); // all remote-present, local-absent → delete
    const client = makeClient({ remoteDirs: tracked.map((d) => d.path) });
    const { engine } = makeEngine({ client, localDirs: ['newdir'], tracked });
    await reconcile(engine, makeSummary());
    expect(client.deleteCollection).not.toHaveBeenCalled();   // destructive batch refused
    expect(client.createDirectory).toHaveBeenCalledWith('newdir'); // creation still happens
  });

  // DP-12 (lock ON wraps the remote delete) was removed in feature 033: file locking is always off,
  // so the remote delete is never lock-wrapped. DP-13 below is now the only behaviour.

  it('DP-13 lock OFF (always, feature 033): issues no lock but still deletes', async () => {
    const client = makeClient({ remoteDirs: ['gone'] });
    const { engine } = makeEngine({ client, localDirs: [], tracked: [dirState('gone')], settings: settings() });
    await reconcile(engine, makeSummary());
    expect(client.lockFile).not.toHaveBeenCalled();
    expect(client.deleteCollection).toHaveBeenCalledWith('gone');
  });

  it('DP-14 self-healing: one failed delete is counted, never aborts the rest', async () => {
    const client = makeClient({
      remoteDirs: ['boom', 'ok'],
      deleteImpl: async (p) => { if (p === 'boom') throw new Error('network'); },
    });
    const { engine } = makeEngine({
      client, localDirs: [], tracked: [dirState('boom'), dirState('ok')],
      settings: settings(),
    });
    const summary = makeSummary();
    await reconcile(engine, summary);
    expect(client.deleteCollection).toHaveBeenCalledWith('ok');
    expect(summary.errorCount).toBe(1);
    // Feature 033: no locking, so no unlock either — the self-healing continuation is the assertion.
    expect(client.lockFile).not.toHaveBeenCalled();
  });

  it('DP-15 self-healing: a listing failure skips the session without throwing', async () => {
    const client = makeClient();
    client.getDirectories.mockRejectedValueOnce(new Error('listing failed'));
    const { engine } = makeEngine({ client, localDirs: ['x'] });
    await expect(reconcile(engine, makeSummary())).resolves.toBeUndefined();
    expect(client.createDirectory).not.toHaveBeenCalled();
  });
});
