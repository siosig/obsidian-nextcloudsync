// [SPEC:WF-1] specs/046-watch-folder-propagation — watch-mode single-folder ops: create (MKCOL,
// idempotent), delete (tracked-only, trashbin), rename (MOVE). Exclusions honored; status bar shows
// activity. Mirrors the file-side syncSingleFile/deleteSingleFile/renameSingleFile behavior.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DavSyncSettings, DirState } from '../../../src/types';

const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;

function settings(over: Partial<DavSyncSettings> = {}): DavSyncSettings {
  return {
    configDir: CONFIG_DIR, syncConfigFolder: false, excludedFolders: [], maxFileSizeMB: 0,
    configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
    ...over,
  } as unknown as DavSyncSettings;
}

function makeEngine(opts: { tracked?: DirState[]; settings?: DavSyncSettings } = {}) {
  const dirs = new Map<string, DirState>((opts.tracked ?? []).map((d) => [d.path, d]));
  const client = {
    createDirectory: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async () => undefined),
    moveFile: jest.fn(async () => undefined),
  };
  const features = { isNextcloud: true, version: '30', hasChecksums: true, hasFilesLocking: false, hasBulkUpload: false, syncToken: null };
  const statusBar = { setStatus: jest.fn(), setProgress: jest.fn(), setSyncComplete: jest.fn(), setErrorCount: jest.fn() };
  const stateDB = {
    getDir: (p: string) => dirs.get(p),
    setDir: (d: DirState) => { dirs.set(d.path, d); },
    deleteDir: (p: string) => { dirs.delete(p); },
    getAllDirs: () => [...dirs.values()],
    requestSave: jest.fn(),
  };
  const engine = new SyncEngine({
    app: { vault: { adapter: {} }, fileManager: {} }, settings: opts.settings ?? settings(),
    localAdapter: {}, stateDB, statusBar,
    webdavFactory: { createClient: jest.fn(async () => ({ client, features })) },
    onFeatures: jest.fn(), pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
  } as never);
  return { engine, client, statusBar, dirs };
}

const dirState = (path: string): DirState => ({ path, remoteFileId: null });

describe('[SPEC:WF-1] SyncEngine.createSingleFolder', () => {
  it('creates the folder on the remote (MKCOL) and tracks it', async () => {
    const { engine, client, dirs } = makeEngine();
    await engine.createSingleFolder('Notes/2026');
    expect(client.createDirectory).toHaveBeenCalledWith('Notes/2026');
    expect(dirs.has('Notes/2026')).toBe(true);
  });

  it('is idempotent: a failing MKCOL (already exists) is swallowed, not thrown', async () => {
    const { engine, client } = makeEngine();
    client.createDirectory.mockRejectedValueOnce(new Error('405 Method Not Allowed'));
    await expect(engine.createSingleFolder('Existing')).resolves.toBeUndefined();
  });

  it('is a no-op for a system-excluded path', async () => {
    const { engine, client } = makeEngine();
    await engine.createSingleFolder('.obsidian/plugins/x');
    expect(client.createDirectory).not.toHaveBeenCalled();
  });

  it('shows status-bar activity while propagating', async () => {
    const { engine, statusBar } = makeEngine();
    await engine.createSingleFolder('New');
    expect(statusBar.setStatus).toHaveBeenCalledWith('syncing');
    expect(statusBar.setStatus).toHaveBeenLastCalledWith('idle');
  });
});

describe('[SPEC:WF-2] SyncEngine.deleteSingleFolder', () => {
  it('deletes a TRACKED folder on the remote (trashbin) and drops tracking', async () => {
    const { engine, client, dirs } = makeEngine({ tracked: [dirState('Old')] });
    await engine.deleteSingleFolder('Old');
    expect(client.deleteCollection).toHaveBeenCalledWith('Old');
    expect(dirs.has('Old')).toBe(false);
  });

  it('is a no-op for an UNTRACKED folder (never on the server)', async () => {
    const { engine, client } = makeEngine({ tracked: [] });
    await engine.deleteSingleFolder('NeverSynced');
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('is a no-op for a system-excluded path', async () => {
    const { engine, client } = makeEngine({ tracked: [dirState('.obsidian/x')] });
    await engine.deleteSingleFolder('.obsidian/x');
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });
});

describe('[SPEC:WF-3] SyncEngine.renameSingleFolder', () => {
  it('MOVEs the folder on the remote and retargets tracking', async () => {
    const { engine, client, dirs } = makeEngine({ tracked: [dirState('A')] });
    await engine.renameSingleFolder('A', 'B');
    expect(client.moveFile).toHaveBeenCalledWith('A', 'B');
    expect(dirs.has('A')).toBe(false);
    expect(dirs.has('B')).toBe(true);
  });

  it('is a no-op only when BOTH old and new are excluded', async () => {
    const { engine, client } = makeEngine();
    await engine.renameSingleFolder('.obsidian/a', '.obsidian/b');
    expect(client.moveFile).not.toHaveBeenCalled();
  });
});
