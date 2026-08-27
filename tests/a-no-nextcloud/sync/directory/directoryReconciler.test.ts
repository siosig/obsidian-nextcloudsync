// Direct tests for DirectoryReconciler (feature 074, addendum).
//
// No [SPEC:...] tags: the clauses this code serves are already claimed by the SyncEngine-level
// suites. What this file adds is reach — this is the highest-complexity function in the codebase
// (CC 39) and, until now, nothing exercised it without standing up an engine.
//
// The subject is the three-way local/remote/tracked classification and the circuit breaker guarding
// its destructive half. The breaker exists because a PARTIAL remote listing is indistinguishable
// from "the user deleted most of their folders", and acting on that difference is unrecoverable.
import { DirectoryReconciler, DirectoryDeps } from '../../../../src/sync/directory/DirectoryReconciler';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { TransferService } from '../../../../src/sync/transfer/TransferService';
import { SyncSessionSummary, RemoteDirInfo, DirState } from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import { TFolder } from '../../support/obsidian';

function summary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

const dir = (path: string, fileId: string | null = null): RemoteDirInfo => ({
  path, fileId, etag: null, lastModified: 0,
});

interface World {
  /** Folders the remote reports. */
  remote: RemoteDirInfo[];
  /** Folders the vault reports. */
  local: string[];
  /** Folders the state DB tracks. */
  tracked: DirState[];
}

function build(world: Partial<World> = {}, over: Partial<DirectoryDeps> = {}) {
  const w: World = { remote: [], local: [], tracked: [], ...world };

  const calls = {
    createDirectory: [] as string[],
    deleteCollection: [] as string[],
    mkdir: [] as string[],
    trash: [] as string[],
    setDir: [] as string[],
    deleteDir: [] as string[],
    lock: [] as string[],
  };
  let dirsEmpty = true;
  let listingFails = false;

  const client = {
    getDirectories: async () => {
      if (listingFails) throw new Error('PROPFIND failed');
      return w.remote;
    },
    createDirectory: async (p: string) => { calls.createDirectory.push(p); },
    deleteCollection: async (p: string) => { calls.deleteCollection.push(p); },
    isRemoteDirEmpty: async () => dirsEmpty,
  } as unknown as IWebDAVClient;

  const journal = new SyncJournal({});

  const deps: DirectoryDeps = {
    app: {
      vault: {
        adapter: { mkdir: async (p: string) => { calls.mkdir.push(p); } },
        getAllFolders: () => w.local.map((p) => new TFolder(p)),
        getAbstractFileByPath: (p: string) => (w.local.includes(p) ? new TFolder(p) : null),
      },
      fileManager: { trashFile: async (f: TFolder) => { calls.trash.push(f.path); } },
    } as unknown as DirectoryDeps['app'],
    stateDB: {
      getAllDirs: () => w.tracked,
      setDir: (d: DirState) => { calls.setDir.push(d.path); },
      deleteDir: (p: string) => { calls.deleteDir.push(p); },
      requestSave: () => { /* noop */ },
    } as unknown as DirectoryDeps['stateDB'],
    journal,
    transfer: {
      acquireLock: async (_c: IWebDAVClient, p: string) => { calls.lock.push(p); return null; },
      releaseLock: async () => { /* noop */ },
    } as unknown as TransferService,
    isSystemExcluded: () => false,
    massDeleteLimit: () => -1, // automatic: max(20, tracked * 0.2)
    isCancelled: () => false,
    ...over,
  };

  return {
    reconciler: new DirectoryReconciler(deps),
    client,
    calls,
    setDirsEmpty: (v: boolean) => { dirsEmpty = v; },
    failListing: () => { listingFails = true; },
  };
}

describe('DirectoryReconciler.reconcileDirectories — the three-way classification', () => {
  it('creates on the remote a folder that exists locally and was never tracked (L !R !T)', async () => {
    const { reconciler, client, calls } = build({ local: ['New'] });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.createDirectory).toEqual(['New']);
    expect(calls.setDir).toContain('New');
  });

  it('creates locally a folder that exists remotely and was never tracked (!L R !T)', async () => {
    const { reconciler, client, calls } = build({ remote: [dir('FromOther')] });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.mkdir).toEqual(['FromOther']);
    expect(calls.setDir).toContain('FromOther');
  });

  it('deletes on the remote a tracked folder that is gone locally (!L R T)', async () => {
    const { reconciler, client, calls } = build({
      remote: [dir('Gone')], tracked: [{ path: 'Gone', remoteFileId: null }],
    });
    const s = summary();
    await reconciler.reconcileDirectories(client, s);
    expect(calls.deleteCollection).toEqual(['Gone']);
    expect(calls.deleteDir).toContain('Gone');
    expect(s.deletedCount).toBe(1);
  });

  it('trashes locally a tracked folder that is gone remotely (L !R T)', async () => {
    const { reconciler, client, calls } = build({
      local: ['Removed'], tracked: [{ path: 'Removed', remoteFileId: null }],
    });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.trash).toEqual(['Removed']);
    expect(calls.deleteDir).toContain('Removed');
  });

  it('keeps tracking a folder present on both sides, refreshing its remote id (L R)', async () => {
    const { reconciler, client, calls } = build({
      local: ['Both'], remote: [dir('Both', 'fid-9')], tracked: [{ path: 'Both', remoteFileId: null }],
    });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.setDir).toEqual(['Both']);
    expect(calls.deleteCollection).toEqual([]);
    expect(calls.trash).toEqual([]);
  });

  it('forgets a tracked folder that is gone from both sides (!L !R T)', async () => {
    const { reconciler, client, calls } = build({ tracked: [{ path: 'Vanished', remoteFileId: null }] });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.deleteDir).toEqual(['Vanished']);
    // Nothing to delete anywhere — it is already absent on both sides.
    expect(calls.deleteCollection).toEqual([]);
    expect(calls.trash).toEqual([]);
  });

  it('skips excluded paths entirely, in every direction', async () => {
    const { reconciler, client, calls } = build(
      { local: ['.git'], remote: [dir('.trash')], tracked: [{ path: '.git', remoteFileId: null }] },
      { isSystemExcluded: (p) => p === '.git' || p === '.trash' },
    );
    await reconciler.reconcileDirectories(client, summary());
    expect(calls).toMatchObject({ createDirectory: [], mkdir: [], deleteCollection: [], trash: [] });
  });
});

describe('DirectoryReconciler.reconcileDirectories — the mass-delete breaker', () => {
  /** `tracked` folders, all present remotely but gone locally ⇒ all are deleteRemote candidates. */
  function allGoneLocally(n: number) {
    const paths = Array.from({ length: n }, (_, i) => `d${i}`);
    return {
      remote: paths.map((p) => dir(p)),
      tracked: paths.map((p) => ({ path: p, remoteFileId: null })),
      local: [],
    };
  }

  it('deletes normally when the destructive set is within the limit', async () => {
    // Automatic limit is max(20, tracked*0.2) = 20 for a small set, so 20 deletions do NOT trip it.
    const { reconciler, client, calls } = build(allGoneLocally(20));
    const s = summary();
    await reconciler.reconcileDirectories(client, s);
    expect(calls.deleteCollection).toHaveLength(20);
    expect(s.errorCount).toBe(0);
  });

  it('refuses the WHOLE destructive set once the limit is exceeded', async () => {
    // 21 > max(20, 21*0.2=4) ⇒ breaker fires. Nothing is deleted — not "all but one".
    const { reconciler, client, calls } = build(allGoneLocally(21));
    const s = summary();
    await reconciler.reconcileDirectories(client, s);
    expect(calls.deleteCollection).toEqual([]);
    expect(calls.trash).toEqual([]);
    expect(s.errorCount).toBe(1);
  });

  it('records the refused paths so the user can settle them later', async () => {
    const { reconciler, client } = build(allGoneLocally(21));
    const s = summary();
    await reconciler.reconcileDirectories(client, s);
    const entry = s.errors.find((e) => e.path === '(dir mass-delete breaker)');
    expect(entry?.dirBreakerSkipped?.deleteRemote).toHaveLength(21);
    expect(entry?.dirBreakerSkipped?.trashLocal).toEqual([]);
  });

  it('still applies the non-destructive half while the breaker holds the rest', async () => {
    // Creations are never part of the destructive set, so they must not be collateral damage.
    const w = allGoneLocally(21);
    const { reconciler, client, calls } = build({ ...w, local: ['Fresh'] });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.createDirectory).toEqual(['Fresh']);
    expect(calls.deleteCollection).toEqual([]);
  });

  it('honours an explicit limit of 0 as "breaker off"', async () => {
    const { reconciler, client, calls } = build(allGoneLocally(50), { massDeleteLimit: () => 0 });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.deleteCollection).toHaveLength(50);
  });

  it('honours a fixed positive limit', async () => {
    const { reconciler, client, calls } = build(allGoneLocally(5), { massDeleteLimit: () => 4 });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.deleteCollection).toEqual([]); // 5 > 4 ⇒ refused
  });
});

describe('DirectoryReconciler.reconcileDirectories — ordering and safety', () => {
  it('creates parents before children', async () => {
    const { reconciler, client, calls } = build({ local: ['a/b/c', 'a', 'a/b'] });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.createDirectory).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it('deletes children before parents', async () => {
    const paths = ['a', 'a/b', 'a/b/c'];
    const { reconciler, client, calls } = build({
      remote: paths.map((p) => dir(p)), tracked: paths.map((p) => ({ path: p, remoteFileId: null })),
    });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.deleteCollection).toEqual(['a/b/c', 'a/b', 'a']);
  });

  it('keeps a remote folder that still has children rather than deleting it', async () => {
    const { reconciler, client, calls, setDirsEmpty } = build({
      remote: [dir('Busy')], tracked: [{ path: 'Busy', remoteFileId: null }],
    });
    setDirsEmpty(false);
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.deleteCollection).toEqual([]);
    expect(calls.deleteDir).not.toContain('Busy'); // still tracked → retried next sync
  });

  it('takes a lock around each remote collection delete', async () => {
    const { reconciler, client, calls } = build({
      remote: [dir('X')], tracked: [{ path: 'X', remoteFileId: null }],
    });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.lock).toEqual(['X']);
  });

  it('stops pulling new work once cancelled', async () => {
    let cancelled = false;
    const { reconciler, client, calls } = build(
      { local: ['a', 'b', 'c'] },
      { isCancelled: () => cancelled },
    );
    cancelled = true;
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.createDirectory).toEqual([]);
  });

  it('abandons the session when the remote listing fails, touching nothing', async () => {
    // A failed listing must never be read as "the remote has no folders".
    const { reconciler, client, calls, failListing } = build({
      local: ['Keep'], tracked: [{ path: 'Keep', remoteFileId: null }],
    });
    failListing();
    await reconciler.reconcileDirectories(client, summary());
    expect(calls).toMatchObject({ createDirectory: [], mkdir: [], deleteCollection: [], trash: [] });
  });

  it('uses the cached directory list instead of listing when one is supplied', async () => {
    // Root-ETag short-circuit: the tracked set IS the remote set, so no PROPFIND is issued.
    const { reconciler, client, calls, failListing } = build({ local: ['Both'] });
    failListing(); // would throw if the listing were attempted
    await reconciler.reconcileDirectories(client, summary(), [dir('Both', 'fid-1')]);
    expect(calls.setDir).toEqual(['Both']);
  });

  it('records a per-path failure without aborting the rest', async () => {
    const { reconciler, client, calls } = build({ local: ['ok1', 'bad', 'ok2'] });
    const s = summary();
    // Make one create fail; the other two must still be attempted.
    const orig = (client as unknown as { createDirectory: (p: string) => Promise<void> }).createDirectory;
    (client as unknown as { createDirectory: (p: string) => Promise<void> }).createDirectory =
      async (p: string) => { if (p === 'bad') throw new Error('boom'); await orig(p); };
    await reconciler.reconcileDirectories(client, s);
    expect(calls.createDirectory).toEqual(['ok1', 'ok2']);
    expect(s.errorCount).toBe(1);
    expect(s.errors[0].message).toContain('dir create (remote) failed');
  });
});

describe('DirectoryReconciler.resolveSkippedDir — settling what the breaker refused', () => {
  it('deleteRemote + remote: recreates the folder locally', async () => {
    const { reconciler, client, calls } = build();
    await reconciler.resolveSkippedDir(client, 'D', 'deleteRemote', 'remote');
    expect(calls.mkdir).toEqual(['D']);
    expect(calls.setDir).toEqual(['D']);
  });

  it('deleteRemote + local: lets the remote deletion proceed', async () => {
    const { reconciler, client, calls } = build();
    await reconciler.resolveSkippedDir(client, 'D', 'deleteRemote', 'local');
    expect(calls.deleteCollection).toEqual(['D']);
    expect(calls.deleteDir).toEqual(['D']);
  });

  it('trashLocal + remote: lets the local deletion proceed', async () => {
    const { reconciler, client, calls } = build({ local: ['D'] });
    await reconciler.resolveSkippedDir(client, 'D', 'trashLocal', 'remote');
    expect(calls.trash).toEqual(['D']);
    expect(calls.deleteDir).toEqual(['D']);
  });

  it('trashLocal + local: recreates the folder on the remote', async () => {
    const { reconciler, client, calls } = build();
    await reconciler.resolveSkippedDir(client, 'D', 'trashLocal', 'local');
    expect(calls.createDirectory).toEqual(['D']);
    expect(calls.setDir).toEqual(['D']);
  });
});

describe('DirectoryReconciler.resolveAllSkippedDirs', () => {
  function breakerSummary(deleteRemote: string[], trashLocal: string[]): SyncSessionSummary {
    const s = summary();
    s.errors.push({ path: '(dir mass-delete breaker)', message: 'skipped', dirBreakerSkipped: { deleteRemote, trashLocal } });
    s.errorCount = 1;
    return s;
  }

  it('does nothing when there is no breaker entry to settle', async () => {
    const { reconciler, client } = build();
    expect(await reconciler.resolveAllSkippedDirs(client, summary(), 'remote')).toEqual({ resolved: 0, failed: 0 });
    expect(await reconciler.resolveAllSkippedDirs(client, null, 'remote')).toEqual({ resolved: 0, failed: 0 });
  });

  it('applies the choice to every refused path and removes the entry when all succeed', async () => {
    const { reconciler, client, calls } = build();
    const s = breakerSummary(['a', 'b'], ['c']);
    expect(await reconciler.resolveAllSkippedDirs(client, s, 'local')).toEqual({ resolved: 3, failed: 0 });
    expect(calls.deleteCollection).toEqual(['a', 'b']);
    expect(calls.createDirectory).toEqual(['c']);
    expect(s.errors).toEqual([]); // the breaker entry is gone
  });

  it('narrows the entry to the still-failed paths on a partial failure', async () => {
    const { reconciler, client } = build();
    (client as unknown as { deleteCollection: (p: string) => Promise<void> }).deleteCollection =
      async (p: string) => { if (p === 'b') throw new Error('boom'); };
    const s = breakerSummary(['a', 'b'], []);
    expect(await reconciler.resolveAllSkippedDirs(client, s, 'local')).toEqual({ resolved: 1, failed: 1 });
    expect(s.errors[0].dirBreakerSkipped).toEqual({ deleteRemote: ['b'], trashLocal: [] });
  });
});
