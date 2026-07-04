// [SPEC:MIR-3] specs/045-remote-mirror-pull — applyRemoteMirror: delete local-only files, reconcile
// StateDB to the remote (converge to zero diff), and bypass the mass-delete breaker (no count limit).
// Downloads themselves route through the already-tested downloadFile path and are verified end-to-end
// in b1; here we focus on the NEW logic: local-only deletion, StateDB convergence, and breaker bypass.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { MirrorPlan } from '../../../src/sync/mirrorPlan';
import { TFile } from '../support/obsidian';
import { DavSyncSettings, FileState, RemoteFileInfo } from '../../../src/types';

const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;

function settings(): DavSyncSettings {
  return {
    configDir: CONFIG_DIR, syncConfigFolder: false, excludedFolders: [],
    configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
  } as unknown as DavSyncSettings;
}

const fstate = (path: string, hash: string): FileState => ({
  path, localHash: hash, remoteId: hash, idType: 'sha256', size: 1, mtime: 0,
  remoteFileId: null, isConflicted: false,
});
const remote = (path: string, checksum: string): RemoteFileInfo => ({
  path, fileId: null, checksum, etag: null, size: 1, lastModified: 0,
});

function makeEngine(opts: { tracked: FileState[]; localFiles: string[] }) {
  const store = new Map<string, FileState>(opts.tracked.map((f) => [f.path, f]));
  const trashFile = jest.fn(async () => undefined);
  const setRemoteRootEtag = jest.fn();
  const setSyncToken = jest.fn();
  const adapter = {
    stat: jest.fn(async () => null),
    exists: jest.fn(async () => false),
    remove: jest.fn(async () => undefined),
    readBinary: jest.fn(async () => new ArrayBuffer(0)),
  };
  const vault = {
    adapter,
    getAllFolders: () => [],
    getAbstractFileByPath: (p: string) => (opts.localFiles.includes(p) ? new TFile(p) : null),
  };
  const app = { vault, fileManager: { trashFile } };
  const stateDB = {
    getFile: (p: string) => store.get(p),
    setFile: (f: FileState) => { store.set(f.path, f); },
    deleteFile: (p: string) => { store.delete(p); },
    getAllFiles: () => [...store.values()],
    getAllDirs: () => [],
    deleteDir: jest.fn(),
    setRemoteRootEtag,
    setSyncToken,
  };
  const engine = new SyncEngine({
    app, settings: settings(), localAdapter: adapter,
    stateDB, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
  } as never);
  return { engine, store, trashFile, setRemoteRootEtag, setSyncToken };
}

const plan = (over: Partial<MirrorPlan>): MirrorPlan => ({
  ok: true, reason: null, downloads: [], deleteFiles: [], deleteDirs: [], skipCount: 0, remoteFiles: [], ...over,
});

describe('[SPEC:MIR-3] SyncEngine.applyRemoteMirror — convergence & breaker bypass', () => {
  it('deletes local-only files via the trash and drops them from StateDB', async () => {
    const { engine, store, trashFile } = makeEngine({
      tracked: [fstate('keep.md', 'h'), fstate('gone1.md', 'x'), fstate('gone2.md', 'y')],
      localFiles: ['keep.md', 'gone1.md', 'gone2.md'],
    });
    const result = await engine.applyRemoteMirror(plan({
      deleteFiles: ['gone1.md', 'gone2.md'],
      skipCount: 1,
      remoteFiles: [remote('keep.md', 'h')],
    }));
    expect(trashFile).toHaveBeenCalledTimes(2);
    expect(result.deleted).toBe(2);
    // Convergence: StateDB now mirrors the remote exactly (only keep.md).
    expect([...store.keys()].sort()).toEqual(['keep.md']);
  });

  it('reconciles StateDB to the remote: skipped files stay tracked, stale entries dropped', async () => {
    const { engine, store } = makeEngine({
      tracked: [fstate('a.md', 'ha'), fstate('stale.md', 'hs')],
      localFiles: ['a.md'],
    });
    // remote has a.md (skipped, already matches) and b.md — but b.md is in downloads (not exercised here);
    // model it as already-present skip to test the reconcile-tracks-skipped branch.
    await engine.applyRemoteMirror(plan({
      skipCount: 1,
      remoteFiles: [remote('a.md', 'ha')],
    }));
    // a.md remains tracked (unchanged); stale.md (not on remote) is dropped → StateDB == remote.
    expect([...store.keys()].sort()).toEqual(['a.md']);
    const a = store.get('a.md')!;
    expect(a.localHash).toBe(a.remoteId); // tracked as "unchanged" so next sync converges (FR-011)
  });

  it('bypasses the mass-delete breaker: deletes far more than 20% of the tracked set', async () => {
    // 100 tracked, 90 local-only to delete (90% ≫ the 20% breaker limit). Must NOT be refused.
    const tracked: FileState[] = [];
    const localFiles: string[] = [];
    const deleteFiles: string[] = [];
    for (let i = 0; i < 90; i++) {
      tracked.push(fstate(`del${i}.md`, `h${i}`));
      localFiles.push(`del${i}.md`);
      deleteFiles.push(`del${i}.md`);
    }
    for (let i = 0; i < 10; i++) tracked.push(fstate(`keep${i}.md`, `k${i}`));
    const remoteFiles = Array.from({ length: 10 }, (_, i) => remote(`keep${i}.md`, `k${i}`));
    const { engine, store, trashFile } = makeEngine({ tracked, localFiles });

    const result = await engine.applyRemoteMirror(plan({ deleteFiles, skipCount: 10, remoteFiles }));

    expect(trashFile).toHaveBeenCalledTimes(90); // all deletions executed, breaker did NOT halt
    expect(result.deleted).toBe(90);
    expect([...store.keys()].sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `keep${i}.md`).sort(),
    );
  });

  it('does nothing when the plan is not ok (listing gate → zero deletions)', async () => {
    const { engine, store, trashFile } = makeEngine({
      tracked: [fstate('a.md', 'h'), fstate('b.md', 'h2')],
      localFiles: ['a.md', 'b.md'],
    });
    const result = await engine.applyRemoteMirror(
      plan({ ok: false, reason: 'network error', deleteFiles: [] }),
    );
    expect(trashFile).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect([...store.keys()].sort()).toEqual(['a.md', 'b.md']); // untouched
  });

  it('forces a real full scan next sync (invalidates root-ETag and sync token)', async () => {
    const { engine, setRemoteRootEtag, setSyncToken } = makeEngine({
      tracked: [fstate('a.md', 'h')], localFiles: ['a.md'],
    });
    await engine.applyRemoteMirror(plan({ remoteFiles: [remote('a.md', 'h')] }));
    expect(setRemoteRootEtag).toHaveBeenCalledWith(null);
    expect(setSyncToken).toHaveBeenCalledWith('');
  });
});
