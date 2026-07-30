// [SPEC:WSF-7] specs/064-watch-single-file-conflict/contracts/watch-single-file-sync.md (C-5)
//
// C-5: full sync exclusivity. While a full sync (syncManual) is running, `syncSingleFile` must not
// touch the network or the local filesystem — it only records the path (in-memory) and returns
// immediately. Once the full sync completes, every recorded path is re-evaluated at least once, and
// recording the same path more than once still yields exactly one re-evaluation. `deleteSingleFile`
// takes the opposite tack: it does NOTHING at all while a full sync is running (not even deferred),
// because the running scan already detects local absence and propagates the deletion itself (C-2
// row 1) — queuing it here would risk a second delete against a path the scan already handled.
//
// These tests drive the REAL SyncEngine (syncManual + syncSingleFile + deleteSingleFile) against a
// real StateDB (in-memory DataAdapter, same harness as untrackedBothSides.test.ts); only the WebDAV
// client and LocalAdapter are test doubles. The full sync is held open for a controllable window by
// making the client's `getFiles` await a promise the test resolves explicitly — never a timer — so
// there is a deterministic window in which `running === true` to probe the watch-mode paths.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, FileState, RemoteFileInfo } from '../../../src/types';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';

function makeStateAdapter(): DataAdapter {
  const store: Record<string, string> = {};
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (f: string, t: string) => { store[t] = store[f]; delete store[f]; }),
    stat: jest.fn(), list: jest.fn(), readBinary: jest.fn(), writeBinary: jest.fn(),
  } as unknown as DataAdapter;
}

/**
 * In-memory local vault used only for the watch-mode single-file calls. `listVaultFiles` (used by the
 * full sync's own scan) always reports empty so the full-sync body itself completes with an empty
 * plan — the point of these tests is the exclusivity gate, not full-sync file classification (already
 * covered elsewhere, e.g. untrackedBothSides.test.ts).
 */
function makeLocalAdapter(files: Record<string, string>) {
  return {
    files,
    listVaultFiles: jest.fn(() => [] as Array<{ path: string; size: number; mtime: number }>),
    stat: jest.fn(async (p: string) =>
      (p in files ? { size: enc.encode(files[p]).length, mtime: 1_000 } : null)),
    exists: jest.fn(async (p: string) => p in files),
    read: jest.fn(async (p: string) => files[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(files[p] ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    setMtime: jest.fn(),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
  };
}

/**
 * Builds a real SyncEngine wired to a real StateDB and a WebDAV client whose `getFiles` call — the
 * first network call the (empty-state) full sync makes — stays pending until the returned
 * `releaseFullSync()` is invoked. This gives the test a deterministic window in which the engine's
 * private `running` flag is true, without relying on any timer.
 */
async function buildEngine(files: Record<string, string> = {}) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const localAdapter = makeLocalAdapter(files);

  let releaseFullSync!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFullSync = resolve; });
  const getFiles = jest.fn(async (): Promise<RemoteFileInfo[]> => { await gate; return []; });
  const getSyncToken = jest.fn(async (): Promise<string | null> => null);
  const statFile = jest.fn(async (): Promise<RemoteFileInfo | null> => null);
  const uploadFile = jest.fn(async () => undefined);
  const deleteFile = jest.fn(async () => undefined);
  const client = { getFiles, getSyncToken, statFile, uploadFile, deleteFile };
  const createClient = jest.fn(async () => ({ client, features: { isNextcloud: false } }));
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };

  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
    localAdapter, stateDB, statusBar, webdavFactory: { createClient },
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  return { engine, stateDB, localAdapter, client, releaseFullSync };
}

/** Seeds a tracked FileState so `deleteSingleFile` treats the path as a known deletion candidate. */
function trackFile(stateDB: StateDB, path: string, body: string): void {
  const fs: FileState = {
    path, localHash: 'h', remoteId: 'h', idType: 'sha256',
    size: enc.encode(body).length, mtime: 1_000, remoteFileId: 'f1', isConflicted: false,
  };
  stateDB.setFile(fs);
}

describe('[SPEC:WSF-7] C-5 — full sync exclusivity for watch-mode single-file ops', () => {
  beforeEach(() => {
    // testEnvironment is 'node'; isBlockedByWifiOnly reads navigator.connection. syncOnWifiOnly=false
    // short-circuits before it, but guard the global so environments without `navigator` don't throw.
    (globalThis as { navigator?: unknown }).navigator ??= {};
  });

  it('defers syncSingleFile while a full sync is running — no network I/O, no local read', async () => {
    const { engine, stateDB, localAdapter, client, releaseFullSync } = await buildEngine({ 'note.md': 'local body' });

    const fullSyncDone = engine.syncManual({ manual: true }); // running becomes true synchronously
    await engine.syncSingleFile('note.md');

    expect(localAdapter.stat).not.toHaveBeenCalled();
    expect(localAdapter.readBinary).not.toHaveBeenCalled();
    expect(client.statFile).not.toHaveBeenCalled();

    releaseFullSync();
    await fullSyncDone; // this also drains the deferred path — flush its resulting requestSave() timer
    await stateDB.flush();
  });

  it('re-evaluates a deferred path once the full sync completes', async () => {
    const { engine, stateDB, client, releaseFullSync } = await buildEngine({ 'note.md': 'local body' });

    const fullSyncDone = engine.syncManual({ manual: true });
    await engine.syncSingleFile('note.md'); // deferred: queued, not run
    expect(client.statFile).not.toHaveBeenCalled();

    releaseFullSync(); // let the full sync finish
    await fullSyncDone;

    expect(client.statFile).toHaveBeenCalledWith('note.md');
    await stateDB.flush(); // drain the debounced requestSave() timer the upload triggered
  });

  it('coalesces repeated defers of the same path into a single re-evaluation', async () => {
    const { engine, stateDB, client, releaseFullSync } = await buildEngine({ 'note.md': 'local body' });

    const fullSyncDone = engine.syncManual({ manual: true });
    await engine.syncSingleFile('note.md');
    await engine.syncSingleFile('note.md'); // queued again — must not double the re-evaluation
    await engine.syncSingleFile('note.md');

    releaseFullSync();
    await fullSyncDone;

    expect(client.statFile).toHaveBeenCalledTimes(1);
    expect(client.statFile).toHaveBeenCalledWith('note.md');
    await stateDB.flush();
  });

  it('re-evaluates two distinct deferred paths independently after the full sync completes', async () => {
    const { engine, stateDB, client, releaseFullSync } = await buildEngine({ 'note.md': 'a', 'other.md': 'b' });

    const fullSyncDone = engine.syncManual({ manual: true });
    await engine.syncSingleFile('note.md');
    await engine.syncSingleFile('other.md');

    releaseFullSync();
    await fullSyncDone;

    expect(client.statFile).toHaveBeenCalledWith('note.md');
    expect(client.statFile).toHaveBeenCalledWith('other.md');
    await stateDB.flush();
  });

  it('does not throw when a re-evaluated path has since vanished locally', async () => {
    const { engine, localAdapter, client, releaseFullSync } = await buildEngine({ 'note.md': 'local body' });

    const fullSyncDone = engine.syncManual({ manual: true });
    await engine.syncSingleFile('note.md'); // deferred while the file still exists

    // The file is removed locally before the deferred re-evaluation runs (e.g. the user deleted it
    // mid-sync). The re-evaluation must see it as gone and no-op — not throw.
    delete localAdapter.files['note.md'];

    releaseFullSync();
    await expect(fullSyncDone).resolves.toBeUndefined();

    // stat() is consulted during the re-evaluation (proving it ran) and reports "gone", so the
    // classification never reaches the network.
    expect(localAdapter.stat).toHaveBeenCalledWith('note.md');
    expect(client.statFile).not.toHaveBeenCalled();
  });

  it('deleteSingleFile does nothing while a full sync is running and leaves StateDB tracking untouched', async () => {
    // 'tracked.md' is tracked in StateDB but absent from the local vault (files: {}) — exactly the
    // real-world trigger for a watch-mode deleteSingleFile call (the file was just deleted locally).
    // The running full sync's own absence-detection is therefore expected to pick it up on its own;
    // C-5/C-2 row 1 is specifically that the SKIPPED deleteSingleFile call contributes nothing extra
    // (no direct client call, no StateDB mutation, no deferral) — not that the delete never happens.
    const { engine, stateDB, client, releaseFullSync } = await buildEngine();
    trackFile(stateDB, 'tracked.md', 'server body');
    const before = stateDB.getFile('tracked.md');

    const fullSyncDone = engine.syncManual({ manual: true });
    await engine.deleteSingleFile('tracked.md');

    // The skipped call itself made no client calls and mutated no state...
    expect(client.statFile).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
    expect(stateDB.getFile('tracked.md')).toEqual(before); // neither dropped nor re-queued

    releaseFullSync();
    await fullSyncDone;

    // ...and the running scan (not the skipped call) is the sole actor: exactly one delete, no
    // duplicate from a queued watch-mode retry (deleteSingleFile never queues).
    expect(client.deleteFile).toHaveBeenCalledTimes(1);
    expect(client.deleteFile).toHaveBeenCalledWith('tracked.md', 'h');
  });
});
