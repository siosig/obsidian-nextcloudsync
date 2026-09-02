// [SPEC:PWR-1] The identity recorded after an upload must be the identity the next classification
// reads back (feature 080).
//
// Found while investigating issue #42 and set aside as a separate, real defect. The two halves of the
// engine disagree about what a file's "remote identity" is:
//
//   recording    TransferService.uploadFile writes remoteId = localHash, idType 'sha256',
//                unconditionally (TransferService.ts:100-101). Its comment reasons from Nextcloud:
//                the OC-Checksum header is sent, Nextcloud stores it, and PROPFIND returns it.
//   classifying  SyncEngine reads remoteId = checksum ?? etag ?? size (SyncEngine.ts:1070).
//
// Against Nextcloud both come out as the same SHA-256 and all is well. Against a plain WebDAV server
// they never agree: StandardWebDAVClient hardcodes `checksum: null` (StandardWebDAVClient.ts:306), so
// classification falls through to the ETag and compares it against a hash. Every file then reads as
// "the remote changed" forever — a re-download each sync at best, and a false conflict, with a merged
// body written over the user's file, whenever the local side changed too.
//
// This is NOT the theory feature 078 refuted. That one asked the server whether it supports
// checksums, and the answer turned out not to predict whether PROPFIND returns them. This asks which
// client is running, and the plain client's null is written into the source — no server involved.
//
// These tests are written to fail while the defect is present.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { TransferService } from '../../../src/sync/transfer/TransferService';
import { StateDB } from '../../../src/data/StateDB';
import { SyncJournal } from '../../../src/sync/session/SyncJournal';
import { MergeBaseRecorder } from '../../../src/sync/session/MergeBaseRecorder';
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';
import { IUploadStrategy } from '../../../src/sync/upload/IUploadStrategy';
import {
  DEFAULT_SETTINGS, FileState, RemoteFileInfo, SyncSessionSummary,
} from '../../../src/types';

const PLUGIN_DIR = '.obsidian/plugins/obsidian-nextcloudsync';
const PATH = 'note.md';
const BODY = 'hello';
/** What a plain WebDAV server returns for this file: an opaque validator, never a checksum. */
const PLAIN_ETAG = '"5f2b1a-3c9"';

function memoryAdapter(): DataAdapter {
  const store: Record<string, string> = {};
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    readBinary: jest.fn(), writeBinary: jest.fn(),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(), rename: jest.fn(), stat: jest.fn(), list: jest.fn(),
  } as unknown as DataAdapter;
}

const summary = (): SyncSessionSummary => ({
  startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
  mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
});

/** A remote file as the PLAIN client reports it: an ETag and, always, a null checksum. */
const plainRemote = (etag: string): RemoteFileInfo => ({
  path: PATH, fileId: null, checksum: null, etag, size: BODY.length, lastModified: 1000,
});

/**
 * Run the real recording path and return the FileState it wrote.
 *
 * Driving TransferService rather than asserting a hand-written baseline is the point: if the
 * recording rule changes, this test follows it instead of quietly testing a copy of it.
 */
async function recordAfterUpload(
  localHash: string,
  opts: { reportsChecksums?: boolean; statFile?: () => Promise<RemoteFileInfo | null> } = {},
): Promise<{ state: FileState; statCalls: number }> {
  const stateDB = new StateDB(memoryAdapter(), PLUGIN_DIR, 'dev-1');
  await stateDB.load();
  const transfer = new TransferService({
    localAdapter: {
      stat: async () => ({ size: BODY.length, mtime: 1000 }),
      readBinary: async () => new TextEncoder().encode(BODY).buffer,
      setMtime: async () => undefined,
    },
    stateDB,
    journal: new SyncJournal({}) as unknown as SyncJournal,
    mergeBase: { record: () => undefined, drop: () => undefined } as unknown as MergeBaseRecorder,
    maxFileSizeMB: () => 0,
    hasFilesLocking: () => false,
    // A plain WebDAV server: the client never fills in a checksum, for any file.
    clientReportsChecksums: () => opts.reportsChecksums ?? false,
    queueRetry: () => undefined,
  } as never);

  // The remote as it stands AFTER the PUT. A plain server hands back a fresh validator and, as
  // always, no checksum.
  let statCalls = 0;
  const client = {
    statFile: async () => {
      statCalls++;
      return opts.statFile ? opts.statFile() : plainRemote(PLAIN_ETAG);
    },
  } as unknown as IWebDAVClient;

  await transfer.uploadFile(
    client,
    { upload: async () => 'uploaded' } as unknown as IUploadStrategy,
    PATH, localHash, PLAIN_ETAG, 'etag', plainRemote('"stale-pre-upload"'), summary(),
  );

  const recorded = stateDB.getFile(PATH);
  if (!recorded) throw new Error('the upload recorded no state at all');
  return { state: recorded, statCalls };
}

/** An engine whose transfer actions are counters, so the test observes the decision. */
async function engineWithBase(base: FileState) {
  const stateDB = new StateDB(memoryAdapter(), PLUGIN_DIR, 'dev-1');
  await stateDB.load();
  stateDB.setFile(base);

  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS },
    localAdapter: {
      stat: async () => ({ size: BODY.length, mtime: 1000 }),
      readBinary: async () => new TextEncoder().encode(BODY).buffer,
    },
    stateDB, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  const calls = { downloads: 0, conflicts: 0, uploads: 0 };
  const e = engine as unknown as Record<string, unknown>;
  e.downloadFile = async () => { calls.downloads++; };
  e.handleConflict = async () => { calls.conflicts++; };
  e.uploadFile = async () => { calls.uploads++; };
  return { engine, calls, stateDB };
}

const classify = (engine: unknown, r: RemoteFileInfo) =>
  (engine as { processRemoteFile: (r: RemoteFileInfo, s: SyncSessionSummary) => Promise<void> })
    .processRemoteFile(r, summary());

describe('[SPEC:PWR-1] what an upload records is what the next sync reads back', () => {
  it('does not re-download a file it just uploaded, on a server without checksums', async () => {
    // The cheap half of the damage, and the one every plain-WebDAV user pays on every sync: nothing
    // changed anywhere, yet the file comes down again because the recorded id and the read-back id
    // are not even the same kind of value.
    const { state: base } = await recordAfterUpload('h-local');
    const { engine, calls } = await engineWithBase(base);
    (engine as unknown as Record<string, unknown>).isLocallyUnchanged = () => true;

    await classify(engine, plainRemote(PLAIN_ETAG)); // unchanged remote: same ETag as before

    expect(calls.downloads).toBe(0);
  });

  it('does not raise a conflict against its own upload while the user keeps editing', async () => {
    // The expensive half. Local changed, remote did not — but the remote reads as changed, so both
    // sides look changed and the resolution writes a merged body over the file being edited. Same
    // class of damage as issue #42, reached by a different route.
    const { state: base } = await recordAfterUpload('h-local');
    const { engine, calls } = await engineWithBase(base);
    (engine as unknown as Record<string, unknown>).isLocallyUnchanged = () => false;

    await classify(engine, plainRemote(PLAIN_ETAG));

    expect(calls.conflicts).toBe(0);
    expect(calls.uploads).toBe(1); // a local-only change is an upload, not a conflict
  });

  it('still sees a genuine remote change', async () => {
    // The direction the fix must not break. Making the two halves agree is worthless if it also
    // silences the case where another device really did write to the server.
    const { state: base } = await recordAfterUpload('h-local');
    const { engine, calls } = await engineWithBase(base);
    (engine as unknown as Record<string, unknown>).isLocallyUnchanged = () => true;

    await classify(engine, plainRemote('"someone-else-wrote-this"'));

    expect(calls.downloads).toBe(1);
  });
});

describe('[SPEC:PWR-2] the Nextcloud path must not pay for the plain-WebDAV fix', () => {
  it('does not re-read the file after an upload when the client reports checksums', async () => {
    // The over-correction this fix could easily have shipped: always ask the server what it now
    // holds. Correct everywhere, and an extra PROPFIND per uploaded file — a thousand of them on a
    // first sync — charged to the users who never had the bug.
    const { statCalls } = await recordAfterUpload('h-local', { reportsChecksums: true });
    expect(statCalls).toBe(0);
  });

  it('keeps recording the local hash on a checksum-reporting server', async () => {
    // Nextcloud stores the OC-Checksum we sent and returns it from PROPFIND, so the hash we already
    // hold IS what the next classification will read. Verified on the official image in feature 078.
    const { state } = await recordAfterUpload('h-local', { reportsChecksums: true });
    expect(state.remoteId).toBe('h-local');
    expect(state.idType).toBe('sha256');
  });
});

describe('[SPEC:PWR-3] when the server cannot be re-read', () => {
  it('falls back to the previous behaviour rather than recording nothing', async () => {
    // Recording nothing would leave the baseline at its pre-upload value, and the next sync would
    // then see both sides changed and resolve a conflict over the user's file. That is worse than
    // the bug being fixed, so the fallback is the old behaviour: one redundant download, after which
    // the download path records the real remote id and the file converges.
    const { state } = await recordAfterUpload('h-local', { statFile: async () => null });
    expect(state.remoteId).toBe('h-local');
    expect(state.idType).toBe('sha256');
  });

  it('does not let a failed re-read abort the upload', async () => {
    const { state } = await recordAfterUpload('h-local', {
      statFile: async () => { throw new Error('network went away'); },
    });
    expect(state.remoteId).toBe('h-local');
  });
});
