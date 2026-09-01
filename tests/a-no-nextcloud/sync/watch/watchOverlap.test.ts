// Overlapping watch cycles on one path (issue #42 investigation, feature 078).
//
// The reported symptom is text being deleted, reformatted, or filled with conflict markers WHILE
// TYPING, on a single device with no other client touching the server. Turning "Sync on file change"
// off stops it. The reporter's log shows conflicts resolving over and over on one file, plus an
// HTTP 423 on a PUT.
//
// Two explanations were investigated and one was measured to death first:
//
//   REFUTED — "the server does not return checksums, so the recorded remoteId can never match".
//     The reporter's capabilities really do lack `checksums`, which looked like confirmation. But
//     running the same official Docker image (nextcloud:latest, 34.0.3) shows PROPFIND returning
//     `oc:checksums` anyway, equal to the local SHA256, and five successive uploads matching every
//     time. Capability absence is not output absence. See specs/078-.../findings.md; the fix that
//     theory implied would have BROKEN every official-image user.
//
//   REMAINING — concurrency. syncSingleFile has no per-path exclusion. It is invoked as
//     `void syncEngine.syncSingleFile(path)` (main.ts) and its steps are: stat -> PROPFIND ->
//     classify -> upload -> record base. Nothing stops a second call for the same path from
//     starting while the first is between its upload and its base record.
//
// These tests drive that interleaving deliberately. They are written to FAIL while the defect is
// present: each asserts the behaviour we want, so a green run means the race is closed.
import { WatchOperations, WatchDeps } from '../../../../src/sync/watch/WatchOperations';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { MergeBaseRecorder } from '../../../../src/sync/session/MergeBaseRecorder';
import { TransferService } from '../../../../src/sync/transfer/TransferService';
import { DeletionService } from '../../../../src/sync/deletion/DeletionService';
import { ResolutionService } from '../../../../src/sync/resolution/ResolutionService';
import { RenameTracker } from '../../../../src/sync/RenameTracker';
import { FileState, RemoteFileInfo, SyncSessionSummary } from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import { IUploadStrategy } from '../../../../src/sync/upload/IUploadStrategy';

const PATH = 'note.md';
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A harness that models the one thing that matters here: the server and the state DB are shared
 * mutable state, and a cycle reads them at one moment and writes them at a later one.
 */
function buildRacy() {
  const events: string[] = [];
  /** The server's current identity for PATH, changed by each upload. */
  let serverId = 'r0';
  /** The recorded baseline, written only after an upload completes. */
  let base: FileState | undefined = {
    path: PATH, localHash: 'h0', remoteId: 'r0', idType: 'etag',
    size: 2, mtime: 1000, remoteFileId: 'fid', isConflicted: false,
  };
  /** Local content, as if the user keeps typing. */
  let localContent = 'h0';
  /** Resolves the pending PROPFIND, so a test can hold a cycle at that exact point. */
  let releaseStat: (() => void) | null = null;

  const client = {
    statFile: async (p: string): Promise<RemoteFileInfo> => {
      events.push(`propfind(${serverId})`);
      if (releaseStat) {
        // Hold this cycle here until the test lets it continue.
        await new Promise<void>((resolve) => { releaseStat = resolve; });
      }
      return { path: p, fileId: 'fid', checksum: null, etag: serverId, size: 2, lastModified: 2000 };
    },
  } as unknown as IWebDAVClient;

  const deps: WatchDeps = {
    localAdapter: {
      stat: async () => ({ size: localContent.length, mtime: 1000 }),
      readBinary: async () => new TextEncoder().encode(localContent).buffer,
    } as unknown as WatchDeps['localAdapter'],
    stateDB: {
      getFile: () => base,
      deleteFile: () => undefined,
      getDir: () => undefined,
      setDir: () => undefined,
      deleteDir: () => undefined,
      requestSave: () => undefined,
      getLastSyncTime: () => 0,
    } as unknown as WatchDeps['stateDB'],
    historyStore: { save: async () => undefined } as unknown as WatchDeps['historyStore'],
    statusBar: { setStatus: () => undefined } as unknown as WatchDeps['statusBar'],
    journal: new SyncJournal({}) as unknown as SyncJournal,
    mergeBase: { record: () => undefined, drop: () => undefined } as unknown as MergeBaseRecorder,
    transfer: { uploadFile: async () => undefined } as unknown as TransferService,
    deletion: { applyLocalDeletion: async () => undefined } as unknown as DeletionService,
    resolution: { dropCleanSnapshot: () => undefined } as unknown as ResolutionService,
    isSystemExcluded: () => false,
    connect: async () => ({ client, uploadStrategy: {} as unknown as IUploadStrategy }),
    renameTracker: () => ({}) as unknown as RenameTracker,
    isSyncRunning: () => false,
    // Stands in for the real classifier. It reproduces the two facts that matter: the decision is
    // taken from (base vs local) and (base vs remote), and the upload changes the server BEFORE the
    // new baseline is recorded.
    processFile: async (r: RemoteFileInfo, _s: SyncSessionSummary) => {
      const remoteChanged = !base || base.remoteId !== r.etag;
      const localChanged = !base || base.localHash !== localContent;
      if (remoteChanged && localChanged) { events.push('CONFLICT'); return; }
      if (localChanged) {
        events.push('upload');
        serverId = localContent;          // the server now holds what we just sent…
        await tick();                     // …and there is a gap before we write it down
        base = {
          path: PATH, localHash: localContent, remoteId: localContent, idType: 'sha256',
          size: localContent.length, mtime: 1000, remoteFileId: 'fid', isConflicted: false,
        };
        events.push('base-recorded');
      }
    },
    queueRetry: () => undefined,
    conflictEncounters: () => 0,
    notify: () => undefined,
  };

  return {
    watch: new WatchOperations(deps),
    events,
    type: (s: string) => { localContent = s; },
    /** Hold the next PROPFIND until release() is called. */
    holdNextStat: () => { releaseStat = () => undefined; },
    release: () => { const r = releaseStat; releaseStat = null; r?.(); },
  };
}

describe('[SPEC:WOV-1] watch cycles on one path must not overlap', () => {
  it('does not turn its own upload into a conflict when a second cycle starts mid-flight', async () => {
    const h = buildRacy();

    // Cycle A: the user typed, so this will upload. Hold it at the PROPFIND.
    h.holdNextStat();
    h.type('h1');
    const a = h.watch.syncSingleFile(PATH);
    await tick();

    // The user keeps typing, and the debounce fires again while A is still in flight.
    h.type('h2');
    const b = h.watch.syncSingleFile(PATH);
    await tick();

    h.release();
    await Promise.all([a, b]);

    // Cycle B must not read cycle A's own upload as "the remote changed". On a single device with
    // no other writer, a conflict here is always the plugin fighting itself.
    expect(h.events).not.toContain('CONFLICT');
  });

  it('serializes the second cycle behind the first instead of interleaving', async () => {
    const h = buildRacy();

    h.holdNextStat();
    h.type('h1');
    const a = h.watch.syncSingleFile(PATH);
    await tick();
    h.type('h2');
    const b = h.watch.syncSingleFile(PATH);
    await tick();
    h.release();
    await Promise.all([a, b]);

    // The second PROPFIND must come after the first cycle has written its baseline. Reading the
    // server between "upload landed" and "baseline recorded" is what manufactures the phantom
    // remote change, and no amount of care inside the classifier can fix a read taken too early.
    const firstBase = h.events.indexOf('base-recorded');
    const propfinds = h.events.reduce<number[]>((acc, e, i) => (e.startsWith('propfind') ? [...acc, i] : acc), []);
    expect(firstBase).toBeGreaterThanOrEqual(0);
    expect(propfinds[1]).toBeGreaterThan(firstBase);
  });
});
