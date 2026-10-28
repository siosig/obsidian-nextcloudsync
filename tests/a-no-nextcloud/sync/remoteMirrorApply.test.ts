// [SPEC:MIR-3] applyRemoteMirror: delete local-only files, reconcile StateDB to the remote (converge to
// zero diff), and bypass the mass-delete breaker. Downloads route through downloadFile and are covered in b1.
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { MirrorPlan } from '../../../src/sync/mirrorPlan';
import { TFile, TFolder } from '../support/obsidian';
import { sha256 } from '../../../src/util/hash';
import { DEFAULT_SETTINGS, DavSyncSettings, FileState, RemoteFileInfo } from '../../../src/types';
import { StateDB } from '../../../src/data/StateDB';
import type { DataAdapter } from 'obsidian';

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

type DirRecord = { path: string; remoteFileId: string | null };

function makeEngine(opts: {
  tracked: FileState[];
  localFiles: string[];
  localDirs?: string[];
  failTrash?: string[];
  trashFile?: jest.Mock;
  stat?: jest.Mock;
  mkdir?: jest.Mock;
  save?: jest.Mock;
  folders?: string[];
  dirs?: (string | DirRecord)[];
  baseStore?: Record<string, unknown>;
  historyStore?: Record<string, unknown>;
}) {
  const store = new Map<string, FileState>(opts.tracked.map((f) => [f.path, f]));
  // Paths that still exist locally (files and folders); trashing removes a path and everything under it.
  const present = new Set<string>([...opts.localFiles, ...(opts.localDirs ?? [])]);
  const failTrash = opts.failTrash ?? [];
  const trashFile = opts.trashFile ?? jest.fn(async (f: { path: string }) => {
    if (failTrash.includes(f.path)) throw new Error('trash failed');
    for (const q of [...present]) if (q === f.path || q.startsWith(f.path + '/')) present.delete(q);
  });
  const setRemoteRootEtag = jest.fn();
  const setSyncToken = jest.fn();
  const adapter = {
    stat: opts.stat ?? jest.fn(async (p: string) => (
      present.has(p) && opts.localFiles.includes(p) ? { size: 1, mtime: 0 } : null)),
    mkdir: opts.mkdir ?? jest.fn(async () => undefined),
    exists: jest.fn(async (p: string) => present.has(p)),
    remove: jest.fn(async () => undefined),
    // Trashing a folder registers its paths as the plugin's own events before the trash runs.
    ignore: jest.fn(),
    readBinary: jest.fn(async () => new ArrayBuffer(0)),
  };
  const vault = {
    adapter,
    getAllFolders: () => (opts.folders ?? []).map((path) => ({ path })),
    getAbstractFileByPath: (p: string) => {
      if (!present.has(p)) return null;
      return opts.localFiles.includes(p) ? new TFile(p) : new TFolder(p);
    },
  };
  const app = { vault, fileManager: { trashFile } };
  const dirStore = new Map<string, DirRecord>(
    (opts.dirs ?? []).map((d) => {
      const rec = typeof d === 'string' ? { path: d, remoteFileId: null } : d;
      return [rec.path, rec];
    }),
  );
  const stateDB = {
    getFile: (p: string) => store.get(p),
    setFile: (f: FileState) => { store.set(f.path, f); },
    deleteFile: (p: string) => { store.delete(p); },
    getAllFiles: () => [...store.values()],
    getAllDirs: () => [...dirStore.values()],
    getDir: (p: string) => dirStore.get(p),
    setDir: jest.fn((d: string | DirRecord) => {
      const rec = typeof d === 'string' ? { path: d, remoteFileId: null } : d;
      dirStore.set(rec.path, rec);
    }),
    save: opts.save ?? jest.fn(async () => undefined),
    deleteDir: jest.fn((p: string) => { dirStore.delete(p); }),
    setRemoteRootEtag,
    setSyncToken,
  };
  const statusBar = {
    setStatus: jest.fn(), setProgress: jest.fn(), setPhase: jest.fn(), setSyncComplete: jest.fn(), setErrorCount: jest.fn(),
  };
  const engine = new SyncEngine({
    app, settings: settings(), localAdapter: adapter,
    stateDB, statusBar, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
    baseStore: opts.baseStore, historyStore: opts.historyStore,
  } as never);
  return {
    engine, store, trashFile, setRemoteRootEtag, setSyncToken, statusBar, adapter, stateDB, present, dirStore,
  };
}

const plan = (over: Partial<MirrorPlan>): MirrorPlan => ({
  ok: true, reason: null, downloads: [], deleteFiles: [], deleteDirs: [], skipCount: 0, remoteFiles: [],
  skipped: [], remoteDirs: [], createDirs: [], ...over,
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
      skipped: [{ path: 'keep.md', size: 1, mtime: 0 }],
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
      skipped: [{ path: 'a.md', size: 1, mtime: 0 }],
      remoteFiles: [remote('a.md', 'ha')],
    }));
    // a.md remains tracked (unchanged); stale.md (not on remote) is dropped → StateDB == remote.
    expect([...store.keys()].sort()).toEqual(['a.md']);
    const a = store.get('a.md')!;
    expect(a.localHash).toBe(a.remoteId); // tracked as "unchanged" so next sync converges
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

    const skipped = Array.from({ length: 10 }, (_, i) => ({ path: `keep${i}.md`, size: 1, mtime: 0 }));
    const result = await engine.applyRemoteMirror(plan({ deleteFiles, skipCount: 10, skipped, remoteFiles }));

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

  it('reports progress like a normal sync: syncing → per-item progress → complete', async () => {
    const { engine, statusBar } = makeEngine({
      tracked: [fstate('keep.md', 'h'), fstate('gone.md', 'x')],
      localFiles: ['keep.md', 'gone.md'],
    });
    await engine.applyRemoteMirror(plan({
      deleteFiles: ['gone.md'],
      remoteFiles: [remote('keep.md', 'h')],
    }));
    expect(statusBar.setStatus).toHaveBeenCalledWith('syncing');
    expect(statusBar.setProgress).toHaveBeenCalledWith(0, 1); // total = 1 deletion
    expect(statusBar.setProgress).toHaveBeenLastCalledWith(1, 1); // ticked to completion
    expect(statusBar.setSyncComplete).toHaveBeenCalledTimes(1); // closes the toast with the result
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

describe('[SPEC:MIR-4] applyRemoteMirror — the sync state is always persisted', () => {
  it('[SPEC:MIR-4] saves once, before the completion toast', async () => {
    const order: string[] = [];
    const save = jest.fn(async () => { order.push('save'); });
    const { engine, statusBar } = makeEngine({
      tracked: [fstate('gone.md', 'x')], localFiles: ['gone.md'], save,
    });
    statusBar.setSyncComplete.mockImplementation(() => { order.push('complete'); });
    await engine.applyRemoteMirror(plan({ deleteFiles: ['gone.md'] }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['save', 'complete']);
  });

  // A failed trash is absorbed inside the deletion service (it notifies and keeps going), so the item
  // failure that reaches the result here is a folder that could not be created.
  it('[SPEC:MIR-4] saves once even when an item fails', async () => {
    const mkdir = jest.fn(async () => { throw new Error('mkdir failed'); });
    const save = jest.fn(async () => undefined);
    const { engine } = makeEngine({ tracked: [], localFiles: [], mkdir, save });
    const result = await engine.applyRemoteMirror(plan({
      createDirs: ['a'],
      remoteDirs: [{ path: 'a', fileId: null, etag: null, lastModified: 0 }],
    }));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe('a');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('[SPEC:MIR-4] reports a failed save as one error entry instead of throwing', async () => {
    const save = jest.fn(async () => { throw new Error('disk full'); });
    const { engine, statusBar } = makeEngine({
      tracked: [fstate('a.md', 'h')], localFiles: ['a.md'], save,
    });
    const result = await engine.applyRemoteMirror(plan({ remoteFiles: [remote('a.md', 'h')] }));
    expect(result.errors.filter((e) => e.path === '(state save)')).toHaveLength(1);
    expect(statusBar.setSyncComplete).toHaveBeenCalledTimes(1);
    expect(statusBar.setSyncComplete.mock.calls[0][3]).toBe(1);
  });

  it('[SPEC:MIR-4] saves the state DB, then the merge bases, then the history', async () => {
    const order: string[] = [];
    const save = jest.fn(async () => { order.push('state'); });
    const baseStore = {
      get: jest.fn(() => undefined), set: jest.fn(), delete: jest.fn(), requestSave: jest.fn(),
      flush: jest.fn(async () => { order.push('bases'); }),
    };
    const historyStore = {
      record: jest.fn(), recent: jest.fn(() => []), since: jest.fn(() => []),
      save: jest.fn(async () => { order.push('history'); }),
    };
    const { engine } = makeEngine({
      tracked: [fstate('gone.md', 'x')], localFiles: ['gone.md'], save, baseStore, historyStore,
    });
    await engine.applyRemoteMirror(plan({ deleteFiles: ['gone.md'] }));
    expect(order).toEqual(['state', 'bases', 'history']);
  });

  it('[SPEC:MIR-4] does not save when the plan is not ok', async () => {
    const save = jest.fn(async () => undefined);
    const { engine } = makeEngine({ tracked: [fstate('a.md', 'h')], localFiles: ['a.md'], save });
    await engine.applyRemoteMirror(plan({ ok: false, reason: 'network error' }));
    expect(save).not.toHaveBeenCalled();
  });
});

describe('[SPEC:MIR-5] applyRemoteMirror — a skipped file changed since the plan is not marked converged', () => {
  const skippedPlan = () => plan({
    skipCount: 1,
    skipped: [{ path: 'a.md', size: 1, mtime: 0 }],
    remoteFiles: [remote('a.md', 'remote-hash')],
  });

  it('[SPEC:MIR-5] leaves the tracked state untouched when the current stat differs', async () => {
    const before = fstate('a.md', 'old-local');
    const stat = jest.fn(async () => ({ size: 2, mtime: 5 }));
    const { engine, store } = makeEngine({ tracked: [before], localFiles: ['a.md'], stat });
    await engine.applyRemoteMirror(skippedPlan());
    expect(store.get('a.md')).toEqual(before);
  });

  it('[SPEC:MIR-5] records the file as converged when the current stat matches the plan', async () => {
    const stat = jest.fn(async () => ({ size: 1, mtime: 0 }));
    const { engine, store } = makeEngine({
      tracked: [fstate('a.md', 'old-local')], localFiles: ['a.md'], stat,
    });
    await engine.applyRemoteMirror(skippedPlan());
    const a = store.get('a.md')!;
    expect(a.localHash).toBe(a.remoteId);
  });
});

describe('[SPEC:MIR-6] applyRemoteMirror — folders are created and tracked', () => {
  const dir = (path: string) => ({ path, fileId: null, etag: null, lastModified: 0 });
  const trackedPaths = (setDir: jest.Mock) =>
    setDir.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : c[0].path));

  it('[SPEC:MIR-6] creates missing folders shallowest first and converges directory tracking', async () => {
    const { engine, adapter, stateDB } = makeEngine({
      tracked: [], localFiles: [], folders: ['a', 'a/b'], dirs: ['gone-locally', 'stale'],
    });
    const result = await engine.applyRemoteMirror(plan({
      createDirs: ['a', 'a/b'],
      remoteDirs: [dir('a'), dir('a/b'), dir('gone-locally')],
    }));
    expect(adapter.mkdir.mock.calls.map((c) => c[0])).toEqual(['a', 'a/b']);
    expect(trackedPaths(stateDB.setDir).sort()).toEqual(['a', 'a/b']);
    expect(stateDB.deleteDir.mock.calls.map((c) => c[0]).sort()).toEqual(['gone-locally', 'stale']);
    expect(result.createdDirs).toBe(2);
  });

  it('[SPEC:MIR-6] records a failed folder creation and continues without tracking it', async () => {
    const mkdir = jest.fn(async (p: string) => { if (p === 'a') throw new Error('mkdir failed'); });
    const { engine, stateDB } = makeEngine({
      tracked: [], localFiles: [], mkdir, folders: ['b'],
    });
    const result = await engine.applyRemoteMirror(plan({
      createDirs: ['a', 'b'],
      remoteDirs: [dir('a'), dir('b')],
    }));
    expect(result.errors.filter((e) => e.path === 'a')).toHaveLength(1);
    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(trackedPaths(stateDB.setDir)).not.toContain('a');
  });
});

describe('[SPEC:MDF-2] applyRemoteMirror — a failed deletion is reported and not counted', () => {
  const three = ['a.md', 'b.md', 'c.md'];
  const dirRec = (path: string) => ({ path, fileId: null, etag: null, lastModified: 0 });

  it('[SPEC:MDF-2] counts only the real deletions and lists the failed one', async () => {
    const { engine, statusBar } = makeEngine({ tracked: [], localFiles: three, failTrash: ['b.md'] });
    const result = await engine.applyRemoteMirror(plan({ deleteFiles: three }));
    expect(result.deleted).toBe(2);
    expect(result.errors).toEqual([{ path: 'b.md', message: 'trash failed' }]);
    expect(statusBar.setSyncComplete.mock.calls[0][3]).toBe(1);
  });

  it('[SPEC:MDF-2] keeps going with other work when every deletion fails', async () => {
    const { engine, adapter } = makeEngine({ tracked: [], localFiles: three, failTrash: three });
    const result = await engine.applyRemoteMirror(plan({
      deleteFiles: three, createDirs: ['x'], remoteDirs: [dirRec('x')],
    }));
    expect(result.deleted).toBe(0);
    expect(result.errors).toHaveLength(3);
    expect(adapter.mkdir.mock.calls.map((c) => c[0])).toContain('x');
  });

  it('[SPEC:MDF-2] reports no error when every deletion succeeds', async () => {
    const { engine } = makeEngine({ tracked: [], localFiles: three });
    const result = await engine.applyRemoteMirror(plan({ deleteFiles: three }));
    expect(result.deleted).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it('[SPEC:MDF-2] treats a path that does not exist as neither a failure nor a deletion', async () => {
    const { engine } = makeEngine({ tracked: [], localFiles: ['a.md'] });
    const result = await engine.applyRemoteMirror(plan({ deleteFiles: ['a.md', 'ghost.md'] }));
    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('[SPEC:MDF-2] does not report a child folder whose parent removed it', async () => {
    const { engine } = makeEngine({
      tracked: [], localFiles: [], localDirs: ['d', 'd/sub'], failTrash: ['d/sub'],
    });
    const result = await engine.applyRemoteMirror(plan({ deleteDirs: ['d/sub', 'd'] }));
    expect(result.deleted).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('[SPEC:MDF-2] reports a folder that could not be removed', async () => {
    const { engine } = makeEngine({ tracked: [], localFiles: [], localDirs: ['d'], failTrash: ['d'] });
    const result = await engine.applyRemoteMirror(plan({ deleteDirs: ['d'] }));
    expect(result.deleted).toBe(0);
    expect(result.errors).toEqual([{ path: 'd', message: 'trash failed' }]);
  });
});

describe('[SPEC:MDF-3] applyRemoteMirror — what is left behind stays tracked', () => {
  let EMPTY_HASH = '';
  beforeAll(async () => { EMPTY_HASH = await sha256(new ArrayBuffer(0)); });

  const expectLeftover = (f: FileState | undefined, remoteFileId: string | null) => {
    expect(f).toEqual(expect.objectContaining({
      path: 'b.md', localHash: EMPTY_HASH, remoteId: EMPTY_HASH, idType: 'sha256', size: 1,
      remoteFileId, isConflicted: false,
    }));
  };

  it('[SPEC:MDF-3] tracks a leftover file at its current content hash and keeps its remote file id', async () => {
    const { engine, store } = makeEngine({
      tracked: [{ ...fstate('b.md', 'old'), remoteFileId: 'fid-b' }],
      localFiles: ['b.md'], failTrash: ['b.md'],
    });
    await engine.applyRemoteMirror(plan({ deleteFiles: ['b.md'] }));
    expectLeftover(store.get('b.md'), 'fid-b');
  });

  it('[SPEC:MDF-3] tracks an untracked leftover file with no remote file id', async () => {
    const { engine, store } = makeEngine({ tracked: [], localFiles: ['b.md'], failTrash: ['b.md'] });
    await engine.applyRemoteMirror(plan({ deleteFiles: ['b.md'] }));
    expectLeftover(store.get('b.md'), null);
  });

  it('[SPEC:MDF-3] records an empty local hash when the leftover file cannot be read', async () => {
    const { engine, store, adapter } = makeEngine({
      tracked: [], localFiles: ['b.md'], failTrash: ['b.md'],
    });
    adapter.readBinary.mockRejectedValue(new Error('read failed'));
    await engine.applyRemoteMirror(plan({ deleteFiles: ['b.md'] }));
    expect(store.get('b.md')!.localHash).toBe('');
  });

  it('[SPEC:MDF-3] tracks an untracked leftover folder', async () => {
    const { engine, dirStore } = makeEngine({
      tracked: [], localFiles: [], localDirs: ['d'], failTrash: ['d'], dirs: [],
    });
    await engine.applyRemoteMirror(plan({ deleteDirs: ['d'] }));
    expect(dirStore.get('d')).toEqual({ path: 'd', remoteFileId: null });
  });

  it('[SPEC:MDF-3] keeps a tracked leftover folder with its remote file id', async () => {
    const { engine, dirStore, stateDB } = makeEngine({
      tracked: [], localFiles: [], localDirs: ['d'], failTrash: ['d'],
      dirs: [{ path: 'd', remoteFileId: 'fid-d' }],
    });
    await engine.applyRemoteMirror(plan({ deleteDirs: ['d'] }));
    expect(dirStore.get('d')!.remoteFileId).toBe('fid-d');
    expect(stateDB.deleteDir.mock.calls.map((c) => c[0])).not.toContain('d');
  });

  it('[SPEC:MDF-3] does not track a file that was deleted', async () => {
    const { engine, store } = makeEngine({
      tracked: [fstate('a.md', 'x')], localFiles: ['a.md'],
    });
    await engine.applyRemoteMirror(plan({ deleteFiles: ['a.md'] }));
    expect(store.has('a.md')).toBe(false);
  });
});

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const PDIR = `${CONFIG_DIR}/plugins/p`;
const QDIR = `${CONFIG_DIR}/plugins/q`;

async function makePluginMirrorWorld(input: { remote: Record<string, string>; local: Record<string, string> }) {
  const vault = new Map<string, string>(Object.entries(input.local));
  const writes: string[] = [];
  const kv: Record<string, string> = {};
  const stateAdapter = {
    read: jest.fn(async (p: string) => kv[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { kv[p] = d; }),
    exists: jest.fn(async (p: string) => p in kv),
    remove: jest.fn(async (p: string) => { delete kv[p]; }),
    rename: jest.fn(async (f: string, t: string) => { kv[t] = kv[f]; delete kv[f]; }),
    stat: jest.fn(), list: jest.fn(), readBinary: jest.fn(), writeBinary: jest.fn(),
  } as unknown as DataAdapter;
  const stateDB = new StateDB(stateAdapter, PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const store = (p: string, d: string): void => { writes.push(p); vault.set(p, d); };
  const sizeOf = (p: string): number => enc.encode(vault.get(p) ?? '').length;
  const localAdapter = {
    listVaultFiles: jest.fn(() => [...vault.keys()].filter((p) => !p.startsWith('.'))
      .map((p) => ({ path: p, size: sizeOf(p), mtime: 1 }))),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    stat: jest.fn(async (p: string) => (vault.has(p) ? { size: sizeOf(p), mtime: 1 } : null)),
    exists: jest.fn(async (p: string) => vault.has(p)),
    read: jest.fn(async (p: string) => vault.get(p) ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(vault.get(p) ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { store(p, d); }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { store(p, dec.decode(d)); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { store(p, dec.decode(d)); }),
    remove: jest.fn(async (p: string) => { vault.delete(p); }),
    ignore: jest.fn(),
  };
  const remoteInfos = async (): Promise<RemoteFileInfo[]> => Promise.all(Object.entries(input.remote).map(
    async ([path, body]) => ({
      path, fileId: `fid-${path}`, checksum: await sha256(toBuf(body)), etag: null, size: enc.encode(body).length, lastModified: 1,
    })));
  const client = {
    getFiles: jest.fn(remoteInfos),
    getDirectories: jest.fn(async () => []),
    getSyncToken: jest.fn(async () => null),
    remoteExists: jest.fn(async (p: string) => p in input.remote),
    recalcChecksum: jest.fn(async () => null),
    downloadFile: jest.fn(async (p: string) => toBuf(input.remote[p] ?? '')),
  };
  const app = {
    vault: {
      adapter: {
        exists: jest.fn(async (p: string) => vault.has(p)),
        remove: jest.fn(async (p: string) => { vault.delete(p); }),
        mkdir: jest.fn(async () => undefined),
      },
      getAbstractFileByPath: (p: string) => (vault.has(p) ? new TFile(p) : null),
      getAllFolders: () => [],
      configDir: CONFIG_DIR,
    },
    fileManager: { trashFile: jest.fn(async (f: TFile) => { vault.delete(f.path); }) },
  };
  const awaiting = new Set<string>();
  const engine = new SyncEngine({
    app, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false, syncConfigFolder: true, syncedCommunityPlugins: ['p'] },
    localAdapter, stateDB, statusBar: { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn(), setPhase: jest.fn() },
    webdavFactory: { createClient: jest.fn(async () => ({ client, features: { isNextcloud: true } })) },
    pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR, pluginsAwaitingRestart: awaiting,
  } as never);
  return { engine, vault, writes, awaiting };
}

describe('[SPEC:CPS-18] Mirror from remote and community plugins', () => {
  beforeEach(() => { (globalThis as { navigator?: unknown }).navigator ??= {}; });

  it('writes the listed plugin code and reports it as needing a restart', async () => {
    const w = await makePluginMirrorWorld({
      remote: { [`${PDIR}/manifest.json`]: '{"id":"p","version":"2.0.0"}', [`${PDIR}/main.js`]: 'code' },
      local: {},
    });
    const result = await w.engine.applyRemoteMirror(await w.engine.planRemoteMirror());
    expect(w.vault.get(`${PDIR}/main.js`)).toBe('code');
    expect(result.pluginsNeedingRestart).toEqual(['p']);
    expect(w.awaiting.has('p')).toBe(true);
  });

  it('does not write the remote files of, or delete the local files of, a plugin that is not listed', async () => {
    const w = await makePluginMirrorWorld({
      remote: { [`${QDIR}/main.js`]: 'remote q', [`${PDIR}/main.js`]: 'code', [`${PDIR}/manifest.json`]: '{"id":"p","version":"1.0.0"}' },
      local: { [`${QDIR}/main.js`]: 'local q', [`${QDIR}/extra.js`]: 'local only' },
    });
    await w.engine.applyRemoteMirror(await w.engine.planRemoteMirror());
    expect(w.vault.get(`${PDIR}/main.js`)).toBe('code');
    expect(w.vault.get(`${QDIR}/main.js`)).toBe('local q');
    expect(w.vault.get(`${QDIR}/extra.js`)).toBe('local only');
  });

  it('does not write data.json of a plugin put awaiting restart between the plan and the apply', async () => {
    const w = await makePluginMirrorWorld({
      remote: {
        [`${PDIR}/manifest.json`]: '{"id":"p","version":"1.0.0"}', [`${PDIR}/main.js`]: 'code', [`${PDIR}/data.json`]: '{"a":1}',
      },
      local: {},
    });
    const planned = await w.engine.planRemoteMirror();
    w.awaiting.add('p');
    await w.engine.applyRemoteMirror(planned);
    expect(w.vault.get(`${PDIR}/main.js`)).toBe('code');
    expect(w.vault.has(`${PDIR}/data.json`)).toBe(false);
  });
});
