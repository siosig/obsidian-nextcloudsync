// [SPEC:MWM-2] While "Wi-Fi only" blocks on cellular, every watch operation ends with zero side effects and one log line (docs/spec.md §5.7c).
import { WatchOperations, WatchDeps } from '../../../../src/sync/watch/WatchOperations';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import type { FileState } from '../../../../src/types';

interface Harness {
  watch: WatchOperations;
  deps: WatchDeps;
  mocks: Record<string, jest.Mock>;
  logs: string[];
  client: Record<string, jest.Mock>;
}

function build(opts: { blocked: boolean; running?: boolean }): Harness {
  const logs: string[] = [];
  const tracked: FileState = {
    path: 'x', localHash: 'h', remoteId: 'h', idType: 'sha256',
    size: 999, mtime: 1, remoteFileId: 'f', isConflicted: false,
  };

  const client = {
    statFile: jest.fn(async () => null),
    createDirectory: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async () => undefined),
    moveFile: jest.fn(async () => undefined),
  };
  const localAdapter = {
    stat: jest.fn(async () => ({ size: 1, mtime: 2 })),
    readBinary: jest.fn(async () => new TextEncoder().encode('z').buffer as ArrayBuffer),
  };
  const stateDB = {
    getFile: jest.fn(() => tracked),
    deleteFile: jest.fn(),
    getDir: jest.fn(() => ({ path: 'd', remoteFileId: null })),
    setDir: jest.fn(),
    deleteDir: jest.fn(),
    requestSave: jest.fn(),
    getLastSyncTime: jest.fn(() => 0),
  };
  const historyStore = { save: jest.fn(async () => undefined) };
  const statusBar = { setStatus: jest.fn() };
  const journal = new SyncJournal({});
  const newSummary = jest.spyOn(journal, 'newSummary');
  const recordError = jest.spyOn(journal, 'recordError');
  const mergeBase = { record: jest.fn(), drop: jest.fn() };
  const transfer = { uploadFile: jest.fn(async () => undefined) };
  const deletion = { deleteLocallyMissing: jest.fn(async () => 'deleted') };
  const resolution = { dropCleanSnapshot: jest.fn() };
  const isSystemExcluded = jest.fn(() => false);
  const connect = jest.fn(async () => ({ client, uploadStrategy: {} }));
  const renameTracker = jest.fn(() => ({ applyLocalRename: jest.fn(async () => undefined) }));
  const isSyncRunning = jest.fn(() => opts.running === true);
  const isBlockedByWifiOnly = jest.fn(() => opts.blocked);
  const processFile = jest.fn(async () => undefined);
  const queueRetry = jest.fn();
  const conflictEncounters = jest.fn(() => 0);
  const logger = { log: jest.fn(async (m: string) => { logs.push(m); }) };
  const notify = jest.fn();

  const deps = {
    localAdapter, stateDB, historyStore, statusBar, journal, mergeBase, transfer, deletion, resolution,
    isSystemExcluded, connect, renameTracker, isBlockedByWifiOnly, isSyncRunning, processFile,
    queueRetry, conflictEncounters, logger, notify,
  } as unknown as WatchDeps;

  // Every port that would leave a trace. isSystemExcluded, isBlockedByWifiOnly and logger.log are
  // left out on purpose: the gate itself is allowed (and required) to consult them.
  const mocks: Record<string, jest.Mock> = {
    statFile: client.statFile,
    createDirectory: client.createDirectory,
    deleteCollection: client.deleteCollection,
    moveFile: client.moveFile,
    stat: localAdapter.stat,
    readBinary: localAdapter.readBinary,
    getFile: stateDB.getFile,
    deleteFile: stateDB.deleteFile,
    getDir: stateDB.getDir,
    setDir: stateDB.setDir,
    deleteDir: stateDB.deleteDir,
    requestSave: stateDB.requestSave,
    getLastSyncTime: stateDB.getLastSyncTime,
    historySave: historyStore.save,
    setStatus: statusBar.setStatus,
    newSummary: newSummary as unknown as jest.Mock,
    recordError: recordError as unknown as jest.Mock,
    mergeBaseRecord: mergeBase.record,
    mergeBaseDrop: mergeBase.drop,
    uploadFile: transfer.uploadFile,
    deleteLocallyMissing: deletion.deleteLocallyMissing,
    dropCleanSnapshot: resolution.dropCleanSnapshot,
    connect,
    renameTracker,
    isSyncRunning,
    processFile,
    queueRetry,
    conflictEncounters,
    notify,
  };

  return { watch: new WatchOperations(deps), deps, mocks, logs, client };
}

const OPS: Array<[string, (w: WatchOperations) => Promise<void>, string]> = [
  ['sync', w => w.syncSingleFile('a.md'),
    'watch: skipped sync a.md — Wi-Fi only is on and the connection is cellular'],
  ['delete', w => w.deleteSingleFile('a.md'),
    'watch: skipped delete a.md — Wi-Fi only is on and the connection is cellular'],
  ['rename', w => w.renameSingleFile('a.md', 'b.md'),
    'watch: skipped rename a.md → b.md — Wi-Fi only is on and the connection is cellular'],
  ['folder-create', w => w.createSingleFolder('d'),
    'watch: skipped folder-create d — Wi-Fi only is on and the connection is cellular'],
  ['folder-delete', w => w.deleteSingleFolder('d'),
    'watch: skipped folder-delete d — Wi-Fi only is on and the connection is cellular'],
  ['folder-rename', w => w.renameSingleFolder('d', 'e'),
    'watch: skipped folder-rename d → e — Wi-Fi only is on and the connection is cellular'],
];

describe('[SPEC:MWM-2] watch mode honours "Wi-Fi only" on cellular', () => {
  it.each(OPS)('[SPEC:MWM-2] blocked: %s has zero side effects', async (_name, run, expectedLog) => {
    const { watch, deps, mocks, logs } = build({ blocked: true });

    await run(watch);

    for (const [name, mock] of Object.entries(mocks)) {
      // The named form first, so a failure says WHICH port was touched.
      expect({ name, calls: mock.mock.calls.length }).toEqual({ name, calls: 0 });
      expect(mock).not.toHaveBeenCalled();
    }
    expect(logs).toEqual([expectedLog]);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it.each(OPS)('[SPEC:MWM-2] not blocked: %s proceeds to the server', async (_name, run) => {
    const { watch, mocks, logs } = build({ blocked: false });

    await run(watch);

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(logs.filter(l => l.startsWith('watch: skipped'))).toEqual([]);
  });

  it('[SPEC:MWM-2] a sync skipped during a full sync is not deferred', async () => {
    const { watch, deps, mocks } = build({ blocked: true, running: true });

    await watch.syncSingleFile('a.md');
    (deps.isBlockedByWifiOnly as jest.Mock).mockReturnValue(false);
    (deps.isSyncRunning as jest.Mock).mockReturnValue(false);
    await watch.drainPending();

    // Had the skip pushed the path into pendingPaths, the drain would now stat and connect.
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.stat).not.toHaveBeenCalled();
  });
});
