// Direct tests for WatchOperations (feature 074, addendum).
//
// No [SPEC:...] tags: WSF-* and the feature-046 clauses stay with the engine-level suites.
//
// Two properties carry most of the risk here.
//
// The asymmetry during a full sync: an EDIT is deferred and re-evaluated afterwards, while a DELETE
// is dropped outright. Both are correct and for different reasons — the running scan would miss a
// late edit, but it already propagates a tracked path that vanished locally, so queuing a delete
// risks a second one. Getting either backwards loses data.
//
// The notification rule: watch mode runs unattended, so it must stay silent for routine outcomes and
// speak up when a resolution actually discarded one side. A conflict settled deterministically shows
// up in NO summary counter, which is exactly the most destructive case.
import { WatchOperations, WatchDeps } from '../../../../src/sync/watch/WatchOperations';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { MergeBaseRecorder } from '../../../../src/sync/session/MergeBaseRecorder';
import { TransferService } from '../../../../src/sync/transfer/TransferService';
import { DeletionService } from '../../../../src/sync/deletion/DeletionService';
import { ResolutionService } from '../../../../src/sync/resolution/ResolutionService';
import { RenameTracker } from '../../../../src/sync/RenameTracker';
import { FileState, RemoteFileInfo, SyncSessionSummary, NetworkError } from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import { IUploadStrategy } from '../../../../src/sync/upload/IUploadStrategy';

const remote = (over: Partial<RemoteFileInfo> = {}): RemoteFileInfo => ({
  path: 'note.md', fileId: 'fid', checksum: null, etag: '"e"', size: 10, lastModified: 2000, ...over,
});

const tracked = (over: Partial<FileState> = {}): FileState => ({
  path: 'note.md', localHash: 'h', remoteId: 'r', idType: 'etag', size: 10, mtime: 1000,
  remoteFileId: 'fid', isConflicted: false, ...over,
});

interface Opts {
  running?: boolean;
  localContent?: string | null;
  /** Signature recorded in the state DB, or undefined for an untracked file. */
  base?: FileState;
  /** What statFile returns; null ⇒ not on the server. */
  onServer?: RemoteFileInfo | null;
  trackedDirs?: string[];
  /** Let processFile mutate the summary so the notification rules can be driven. */
  processFile?: (r: RemoteFileInfo, s: SyncSessionSummary) => Promise<void>;
  conflicts?: () => number;
  failRename?: boolean;
  failFolderDelete?: boolean;
}

function build(o: Opts = {}, over: Partial<WatchDeps> = {}) {
  const calls = {
    processed: [] as string[],
    uploaded: [] as string[],
    deleted: [] as string[],
    deleteFile: [] as string[],
    setDir: [] as string[],
    deleteDir: [] as string[],
    droppedBase: [] as string[],
    droppedSnap: [] as string[],
    history: [] as string[],
    retries: [] as string[],
    status: [] as string[],
    notices: [] as string[],
    saves: 0,
    createDirectory: [] as string[],
    deleteCollection: [] as string[],
    move: [] as Array<[string, string]>,
    renames: [] as Array<[string, string]>,
    statCalls: 0,
    readCalls: 0,
  };

  const client = {
    statFile: async (p: string) => (o.onServer === undefined ? remote({ path: p }) : o.onServer),
    createDirectory: async (p: string) => { calls.createDirectory.push(p); },
    deleteCollection: async (p: string) => {
      if (o.failFolderDelete) throw new Error('boom');
      calls.deleteCollection.push(p);
    },
    moveFile: async (a: string, b: string) => { calls.move.push([a, b]); },
  } as unknown as IWebDAVClient;

  const deps: WatchDeps = {
    localAdapter: {
      stat: async () => {
        calls.statCalls++;
        return o.localContent == null ? null : { size: o.localContent.length, mtime: 1000 };
      },
      readBinary: async () => {
        calls.readCalls++;
        return new TextEncoder().encode(o.localContent ?? '').buffer;
      },
    } as unknown as WatchDeps['localAdapter'],
    stateDB: {
      getFile: () => o.base,
      deleteFile: (p: string) => { calls.deleteFile.push(p); },
      getDir: (p: string) => (o.trackedDirs?.includes(p) ? { path: p, remoteFileId: null } : undefined),
      setDir: (d: { path: string }) => { calls.setDir.push(d.path); },
      deleteDir: (p: string) => { calls.deleteDir.push(p); },
      requestSave: () => { calls.saves++; },
      getLastSyncTime: () => 0,
    } as unknown as WatchDeps['stateDB'],
    historyStore: { save: async () => { /* noop */ } } as unknown as WatchDeps['historyStore'],
    statusBar: { setStatus: (s: string) => { calls.status.push(s); } } as unknown as WatchDeps['statusBar'],
    journal: Object.assign(new SyncJournal({}), {
      recordHistory: (p: string, op: string) => { calls.history.push(`${op}:${p}`); },
    }) as unknown as SyncJournal,
    mergeBase: {
      record: () => { /* noop */ },
      drop: (p: string) => { calls.droppedBase.push(p); },
    } as unknown as MergeBaseRecorder,
    transfer: {
      uploadFile: async (_c: unknown, _u: unknown, p: string) => { calls.uploaded.push(p); },
    } as unknown as TransferService,
    deletion: {
      applyLocalDeletion: async (_c: unknown, r: RemoteFileInfo) => { calls.deleted.push(r.path); },
    } as unknown as DeletionService,
    resolution: {
      dropCleanSnapshot: (p: string) => { calls.droppedSnap.push(p); },
    } as unknown as ResolutionService,
    isSystemExcluded: () => false,
    connect: async () => ({ client, uploadStrategy: {} as unknown as IUploadStrategy }),
    renameTracker: () => ({
      applyLocalRename: async (a: string, b: string) => {
        if (o.failRename) throw new Error('boom');
        calls.renames.push([a, b]);
      },
    }) as unknown as RenameTracker,
    isSyncRunning: () => o.running === true,
    processFile: async (r: RemoteFileInfo, s: SyncSessionSummary) => {
      calls.processed.push(r.path);
      await o.processFile?.(r, s);
    },
    queueRetry: (p: string) => { calls.retries.push(p); },
    conflictEncounters: o.conflicts ?? (() => 0),
    notify: (m: string) => { calls.notices.push(m); },
    ...over,
  };

  return { watch: new WatchOperations(deps), calls };
}

describe('WatchOperations.syncSingleFile — never alongside a full sync', () => {
  it('defers the path instead of racing the running scan', async () => {
    const { watch, calls } = build({ running: true, localContent: 'x' });
    await watch.syncSingleFile('note.md');
    expect(calls.processed).toEqual([]);
    expect(calls.statCalls).toBe(0); // it does not even look at the file
  });

  it('re-evaluates deferred paths once the run finishes', async () => {
    let running = true;
    const { watch, calls } = build({ localContent: 'new body' }, { isSyncRunning: () => running });
    await watch.syncSingleFile('a.md');
    await watch.syncSingleFile('b.md');
    expect(calls.processed).toEqual([]);
    running = false;
    await watch.drainPending();
    expect(calls.processed).toEqual(['a.md', 'b.md']);
  });

  it('drains only once — a second drain has nothing left', async () => {
    let running = true;
    const { watch, calls } = build({ localContent: 'x' }, { isSyncRunning: () => running });
    await watch.syncSingleFile('a.md');
    running = false;
    await watch.drainPending();
    await watch.drainPending();
    expect(calls.processed).toEqual(['a.md']);
  });
});

describe('WatchOperations.syncSingleFile — deciding whether a round-trip is worth it', () => {
  it('returns without touching the network when the stat signature says unchanged', async () => {
    const { watch, calls } = build({
      localContent: '0123456789',
      base: tracked({ localMtime: 1000, localSize: 10 }),
    });
    await watch.syncSingleFile('note.md');
    expect(calls.readCalls).toBe(0); // the fast path answers before reading the file
    expect(calls.processed).toEqual([]);
  });

  it('returns when the content hashes the same as the recorded baseline (mtime-only touch)', async () => {
    const body = 'same body';
    const hash = await (await import('../../../../src/util/hash')).sha256(new TextEncoder().encode(body).buffer);
    const { watch, calls } = build({ localContent: body, base: tracked({ localHash: hash }) });
    await watch.syncSingleFile('note.md');
    expect(calls.readCalls).toBe(1); // it had to read to find out
    expect(calls.processed).toEqual([]);
  });

  it('hands a changed file to the full sync classifier rather than deciding itself', async () => {
    const { watch, calls } = build({ localContent: 'edited', base: tracked() });
    await watch.syncSingleFile('note.md');
    expect(calls.processed).toEqual(['note.md']);
    expect(calls.uploaded).toEqual([]); // no separate upload path
  });

  it('uploads as new when the file is not on the server at all', async () => {
    const { watch, calls } = build({ localContent: 'brand new', onServer: null });
    await watch.syncSingleFile('note.md');
    expect(calls.uploaded).toEqual(['note.md']);
    expect(calls.processed).toEqual([]);
  });

  it('does nothing for an excluded path', async () => {
    const { watch, calls } = build({ localContent: 'x' }, { isSystemExcluded: () => true });
    await watch.syncSingleFile('.obsidian/plugins/other/main.js');
    expect(calls.statCalls).toBe(0);
  });

  it('does nothing when the file was deleted before the debounce fired', async () => {
    const { watch, calls } = build({ localContent: null });
    await watch.syncSingleFile('note.md');
    expect(calls.processed).toEqual([]);
  });

  it('queues a retry on a network failure, and only on a network failure', async () => {
    const net = build({
      localContent: 'x',
      processFile: () => { throw new NetworkError(500, '', 'PUT'); },
    });
    await net.watch.syncSingleFile('note.md');
    expect(net.calls.retries).toEqual(['note.md']);

    const local = build({
      localContent: 'x',
      processFile: () => { throw new Error('ENOENT'); },
    });
    await local.watch.syncSingleFile('note.md');
    expect(local.calls.retries).toEqual([]); // retrying a local I/O error just fails again
  });
});

describe('WatchOperations.deleteSingleFile', () => {
  it('DROPS the deletion during a full sync instead of deferring it', async () => {
    // The asymmetry with syncSingleFile is deliberate: the running scan already propagates a tracked
    // path that is gone locally, so queuing this would risk a second delete.
    const { watch, calls } = build({ running: true, base: tracked() });
    await watch.deleteSingleFile('note.md');
    expect(calls.deleted).toEqual([]);
    expect(calls.deleteFile).toEqual([]);
  });

  it('does nothing for an untracked file — it was never on the server', async () => {
    const { watch, calls } = build({ base: undefined });
    await watch.deleteSingleFile('note.md');
    expect(calls.deleted).toEqual([]);
  });

  it('runs the SAME guarded deletion the full sync uses', async () => {
    const { watch, calls } = build({ base: tracked() });
    await watch.deleteSingleFile('note.md');
    expect(calls.deleted).toEqual(['note.md']); // not a blind DELETE
  });

  it('stops tracking a file that is already gone on the server', async () => {
    const { watch, calls } = build({ base: tracked(), onServer: null });
    await watch.deleteSingleFile('note.md');
    expect(calls.history).toEqual(['deleted:note.md']);
    expect(calls.deleteFile).toEqual(['note.md']);
    expect(calls.droppedBase).toEqual(['note.md']);
    expect(calls.droppedSnap).toEqual(['note.md']);
  });
});

describe('WatchOperations — folder operations (feature 046)', () => {
  it('creates a folder on the remote and tracks it', async () => {
    const { watch, calls } = build();
    await watch.createSingleFolder('New');
    expect(calls.createDirectory).toEqual(['New']);
    expect(calls.setDir).toEqual(['New']);
  });

  it('does not propagate the deletion of an untracked folder', async () => {
    const { watch, calls } = build({ trackedDirs: [] });
    await watch.deleteSingleFolder('Never');
    expect(calls.deleteCollection).toEqual([]);
  });

  it('deletes a tracked folder and drops its tracking', async () => {
    const { watch, calls } = build({ trackedDirs: ['Old'] });
    await watch.deleteSingleFolder('Old');
    expect(calls.deleteCollection).toEqual(['Old']);
    expect(calls.deleteDir).toEqual(['Old']);
  });

  it('KEEPS the tracking when the remote delete failed', async () => {
    // G1-2: dropping it would make the next sync re-create the folder locally.
    const { watch, calls } = build({ trackedDirs: ['Old'], failFolderDelete: true });
    await watch.deleteSingleFolder('Old');
    expect(calls.deleteDir).toEqual([]);
  });

  it('moves a folder and re-tracks it under the new path', async () => {
    const { watch, calls } = build();
    await watch.renameSingleFolder('Old', 'New');
    expect(calls.move).toEqual([['Old', 'New']]);
    expect(calls.deleteDir).toEqual(['Old']);
    expect(calls.setDir).toEqual(['New']);
  });

  it('renames a file through the rename tracker', async () => {
    const { watch, calls } = build();
    await watch.renameSingleFile('a.md', 'b.md');
    expect(calls.renames).toEqual([['a.md', 'b.md']]);
  });

  it('swallows a rename failure rather than surfacing it — the next sync converges', async () => {
    const { watch, calls } = build({ failRename: true });
    await expect(watch.renameSingleFile('a.md', 'b.md')).resolves.toBeUndefined();
    expect(calls.renames).toEqual([]);
  });

  it('skips a folder operation only when BOTH sides of a rename are excluded', async () => {
    const { watch, calls } = build({}, { isSystemExcluded: (p) => p === 'Old' });
    await watch.renameSingleFolder('Old', 'Visible');
    expect(calls.move).toEqual([['Old', 'Visible']]); // moving INTO scope still propagates
  });
});

describe('WatchOperations — the notification rule', () => {
  async function outcome(mutate: (s: SyncSessionSummary) => void, conflicts = () => 0) {
    const { watch, calls } = build({
      localContent: 'edited', base: tracked(), conflicts,
      processFile: async (_r, s) => { mutate(s); },
    });
    await watch.syncSingleFile('note.md');
    return calls.notices;
  }

  it('says nothing about a routine upload or download', async () => {
    expect(await outcome((s) => { s.uploadedCount++; })).toEqual([]);
    expect(await outcome((s) => { s.downloadedCount++; })).toEqual([]);
  });

  it('reports a failure', async () => {
    expect((await outcome((s) => { s.errorCount++; }))[0]).toContain('Sync failed');
  });

  it('reports a conflict that left both versions in the note', async () => {
    expect((await outcome((s) => { s.conflictedCount++; }))[0]).toContain('Conflict in');
  });

  it('reports a merge', async () => {
    expect((await outcome((s) => { s.mergedCount++; }))[0]).toContain('Merged remote changes');
  });

  it('reports a conflict settled deterministically, which no counter records', async () => {
    // This is the case where one side's content was dropped outright. Notifying only on
    // merged/conflicted would stay silent about the most destructive resolution of all.
    let n = 0;
    const notices = await outcome((s) => { s.uploadedCount++; n = 1; }, () => n);
    expect(notices[0]).toContain('changed on both sides');
  });

  it('prefers the failure message when a run both failed and conflicted', async () => {
    const notices = await outcome((s) => { s.errorCount++; s.conflictedCount++; });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Sync failed');
  });
});

describe('WatchOperations — the status bar', () => {
  it('shows activity for the duration of an operation and returns to idle', async () => {
    const { watch, calls } = build({ localContent: 'edited', base: tracked() });
    await watch.syncSingleFile('note.md');
    expect(calls.status).toEqual(['syncing', 'idle']);
  });

  it('leaves the status alone while a full sync owns it', async () => {
    // The status is set before the running check for a delete, so drive it through a folder op.
    const { watch, calls } = build({ running: true, trackedDirs: ['Old'] });
    await watch.deleteSingleFolder('Old');
    expect(calls.status).toEqual([]);
  });
});
