// [SPEC:MDF-4] A local deletion that fails in an ordinary sync keeps its tracking entry for a retry. That entry
// describes a file the server no longer has, so the next sync must not short-circuit: a listing rebuilt from
// State would report the file as still on the server and the retry would never run (docs/spec.md §8a.5).
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { TFile } from '../support/obsidian';
import { DavSyncSettings, FileState, SyncSessionSummary } from '../../../src/types';

const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;

function settings(): DavSyncSettings {
  return {
    configDir: CONFIG_DIR, syncConfigFolder: false, excludedFolders: [],
    configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
  } as unknown as DavSyncSettings;
}

function summary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

function makeEngine(opts: { present: boolean; trashFails: boolean }) {
  const state: FileState = {
    path: 'note.md', localHash: 'h', remoteId: 'h', idType: 'sha256', size: 1, mtime: 0,
    remoteFileId: null, isConflicted: false,
  };
  const store = new Map<string, FileState>([[state.path, state]]);
  const setRemoteRootEtag = jest.fn();
  const trashFile = jest.fn(async () => { if (opts.trashFails) throw new Error('trash failed'); });
  const adapter = {
    stat: jest.fn(async () => null), exists: jest.fn(async () => false), remove: jest.fn(async () => undefined),
    ignore: jest.fn(),
  };
  const vault = {
    adapter,
    getAllFolders: () => [],
    getAbstractFileByPath: (p: string) => (opts.present && p === 'note.md' ? new TFile(p) : null),
  };
  const stateDB = {
    getFile: (p: string) => store.get(p),
    setFile: (f: FileState) => { store.set(f.path, f); },
    deleteFile: (p: string) => { store.delete(p); },
    getAllFiles: () => [...store.values()],
    getAllDirs: () => [],
    deleteDir: jest.fn(),
    setRemoteRootEtag,
  };
  const engine = new SyncEngine({
    app: { vault, fileManager: { trashFile } }, settings: settings(), localAdapter: adapter,
    stateDB, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
  } as never);
  const run = (): Promise<void> =>
    (engine as unknown as { processRemoteDeletion: (p: string, s: SyncSessionSummary) => Promise<void> })
      .processRemoteDeletion('note.md', summary());
  return { run, store, setRemoteRootEtag };
}

describe('[SPEC:MDF-4] a failed local deletion in an ordinary sync forces the next sync to rescan', () => {
  it('[SPEC:MDF-4] clears the stored root ETag and keeps the entry when the trash fails', async () => {
    const { run, store, setRemoteRootEtag } = makeEngine({ present: true, trashFails: true });
    await run();
    expect(store.has('note.md')).toBe(true);
    expect(setRemoteRootEtag).toHaveBeenCalledTimes(1);
    expect(setRemoteRootEtag).toHaveBeenCalledWith(null);
  });

  it('[SPEC:MDF-4] leaves the root ETag alone when the deletion succeeds', async () => {
    const { run, store, setRemoteRootEtag } = makeEngine({ present: true, trashFails: false });
    await run();
    expect(store.has('note.md')).toBe(false);
    expect(setRemoteRootEtag).not.toHaveBeenCalled();
  });

  it('[SPEC:MDF-4] leaves the root ETag alone when the file was already gone', async () => {
    const { run, store, setRemoteRootEtag } = makeEngine({ present: false, trashFails: false });
    await run();
    expect(store.has('note.md')).toBe(false);
    expect(setRemoteRootEtag).not.toHaveBeenCalled();
  });
});
