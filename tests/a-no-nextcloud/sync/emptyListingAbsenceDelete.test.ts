// [SPEC:EAD-1] [SPEC:EAD-2] [SPEC:EAD-3] [SPEC:EAD-4] An empty remote listing is a listing, not a
// reason to stop reconciling (feature 083, GitHub issue #50).
//
// The report: a vault holding a single note. The note is deleted on another device; this device syncs,
// logs `REAL full scan (remote=0)` — and then `del=0`. The note stays. Every later sync makes it
// worse: the root-ETag short-circuit rebuilds the listing from State, the stale entry is rebuilt as
// "present on the server", and nothing ever re-examines it. The vault never converges until some
// unrelated file is added and the listing is non-empty again.
//
// The cause is one clause. The full-scan absence-deletion block is guarded by
// `isFullScan && remotePathSet.size > 0`, so a listing of zero files skips candidate enumeration
// entirely. That guard was added (3d74a01) when it was the ONLY protection against a truncated or
// failed listing wiping a vault. The very next release (c441390) added the two defences that actually
// carry that weight — the mass-delete breaker, and a per-candidate Depth 0 PROPFIND that must return
// 404 before anything is trashed — and the size check has been redundant ever since. Redundant, and
// wrong for exactly one vault shape: the small one, where "everything is gone" is a thing that
// genuinely happens.
//
// Why deleting on an empty listing is safe. The listing PROPFIND does not fail quietly: a non-207
// response throws, and a missing vault folder is a distinct, separately-handled case (VRR-*), so an
// empty array means the server really did answer "nothing here". On top of that, no file is trashed
// on the strength of the listing alone — each candidate is asked about directly, and only a definitive
// 404 counts (EAD-3), with the breaker refusing the whole batch when too much of the vault looks gone
// at once (EAD-4). Removing the guard removes a false negative, not a safety net.
//
// These tests drive the REAL SyncEngine against a real StateDB (in-memory DataAdapter); only the
// WebDAV client, the LocalAdapter and Obsidian's App are test doubles. Re-implementing the
// classification in a mock would prove nothing here — this bug lives in the classification.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';
import { TFile } from '../support/obsidian';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';

// 1970. Far enough from both `now` and the last-sync time that the stat-signature fast-path is not
// suppressed by its safety window, so a tracked file with a matching signature reads as "locally
// unchanged" and is never queued for upload.
const BASE_MTIME = 1_000;

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
 * In-memory local vault. `listVaultFiles` is what the full scan enumerates, so it is derived from the
 * file map rather than fixed: a file the sync trashes disappears from the next scan on its own.
 */
function makeLocalAdapter(files: Record<string, string>) {
  const sizeOf = (p: string): number => enc.encode(files[p]).length;
  return {
    files,
    listVaultFiles: jest.fn(() =>
      Object.keys(files).map(p => ({ path: p, size: sizeOf(p), mtime: BASE_MTIME }))),
    list: jest.fn(async () => ({ files: [], folders: [] })), // no dot paths in these vaults
    stat: jest.fn(async (p: string) => (p in files ? { size: sizeOf(p), mtime: BASE_MTIME } : null)),
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

/** What the client double answers with, mutable between syncs within one test. */
interface RemoteWorld {
  /** The full-scan listing (`getFiles('')`). */
  listing: RemoteFileInfo[];
  /** Vault root ETag. Constant across syncs means "nothing changed" → short-circuit. */
  rootEtag: string | null;
  /**
   * The per-candidate Depth 0 re-check: a blanket answer, a per-path answer, or `'reject'` for a
   * client that cannot answer at all.
   */
  exists: boolean | 'reject' | ((path: string) => boolean);
}

async function buildEngine(vault: Record<string, string>, world: RemoteWorld) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const localAdapter = makeLocalAdapter(vault);

  const client = {
    getRootEtag: jest.fn(async () => world.rootEtag),
    getFiles: jest.fn(async () => world.listing),
    getSyncToken: jest.fn(async (): Promise<string | null> => null), // Nextcloud: REPORT unsupported
    remoteExists: jest.fn(async (p: string) => {
      if (world.exists === 'reject') throw new Error('offline');
      return typeof world.exists === 'function' ? world.exists(p) : world.exists;
    }),
    statFile: jest.fn(async (): Promise<RemoteFileInfo | null> => null),
    uploadFile: jest.fn(async () => undefined),
    deleteFile: jest.fn(async () => undefined),
    getDirectories: jest.fn(async () => []),
    createDirectory: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async () => undefined),
    isRemoteDirEmpty: jest.fn(async () => true),
    recalcChecksum: jest.fn(async (): Promise<string | null> => null),
    downloadFile: jest.fn(async () => toBuf('')),
  };
  // isNextcloud drives two things this file depends on: the root-ETag short-circuit (Nextcloud-only)
  // and the "the server reports checksums" assumption that keeps uploads from re-statting.
  const createClient = jest.fn(async () => ({ client, features: { isNextcloud: true } }));

  const trashed: string[] = [];
  const app = {
    vault: {
      adapter: {
        exists: jest.fn(async (p: string) => p in vault),
        remove: jest.fn(async (p: string) => { delete vault[p]; }),
        mkdir: jest.fn(async () => undefined),
      },
      getAbstractFileByPath: (p: string) => (p in vault ? new TFile(p) : null),
      getAllFolders: () => [],
    },
    fileManager: {
      trashFile: jest.fn(async (f: TFile) => { trashed.push(f.path); delete vault[f.path]; }),
    },
  };

  const logs: string[] = [];
  const logger = { log: jest.fn(async (m: string) => { logs.push(m); }) };
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };

  const engine = new SyncEngine({
    app, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
    localAdapter, stateDB, statusBar, webdavFactory: { createClient }, logger,
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  const sync = async (): Promise<SyncSessionSummary> => {
    await engine.syncManual({ manual: true });
    await stateDB.flush(); // drain the debounced requestSave() timer
    return engine.getLastSessionSummary()!;
  };

  return { engine, stateDB, localAdapter, client, app, trashed, logs, sync, vault };
}

/**
 * Records `path` as converged: the recorded hash matches the body on disk, and the stat signature
 * matches what the vault double reports. Both matter — the signature keeps the file out of the upload
 * pass, and the hash is what the absence pass compares against before considering it a candidate.
 */
async function track(stateDB: StateDB, path: string, body: string): Promise<FileState> {
  const hash = await sha256(toBuf(body));
  const size = enc.encode(body).length;
  const fs: FileState = {
    path, localHash: hash, remoteId: hash, idType: 'sha256',
    size, mtime: BASE_MTIME, remoteFileId: `fid-${path}`, isConflicted: false,
    localMtime: BASE_MTIME, localSize: size, remoteMtime: BASE_MTIME,
  };
  stateDB.setFile(fs);
  return fs;
}

beforeEach(() => {
  // testEnvironment is 'node'; isBlockedByWifiOnly reads navigator.connection. syncOnWifiOnly=false
  // short-circuits before it, but guard the global so this environment does not throw.
  (globalThis as { navigator?: unknown }).navigator ??= {};
});

describe('[SPEC:EAD-1] the last file in a vault, deleted on another device, is deleted here', () => {
  it('confirms the absence with a Depth 0 re-check and trashes the file', async () => {
    const world: RemoteWorld = { listing: [], rootEtag: 'etag-empty', exists: false };
    const h = await buildEngine({ 'メモ.md': 'note body' }, world);
    await track(h.stateDB, 'メモ.md', 'note body');

    const summary = await h.sync();

    // The listing said nothing; the server was asked about this one path directly, and said 404.
    expect(h.client.getFiles).toHaveBeenCalledTimes(1);
    expect(h.client.remoteExists).toHaveBeenCalledTimes(1);
    expect(h.client.remoteExists).toHaveBeenCalledWith('メモ.md');

    expect(h.trashed).toEqual(['メモ.md']);
    expect(h.app.fileManager.trashFile).toHaveBeenCalledTimes(1);
    expect(h.vault['メモ.md']).toBeUndefined();
    expect(h.stateDB.getFile('メモ.md')).toBeUndefined(); // FR-005: no ghost left for the rebuild
    expect(summary.errorCount).toBe(0);

    // A remote deletion applied locally is counted by processRemoteDeletion, which has always
    // incremented `downloadedCount` (the "changes brought down from the server" counter) rather than
    // `deletedCount` (which counts local deletions pushed UP). spec.md's "del=1" phrasing is about the
    // outcome, not this counter; nothing in feature 083 changes where it lands.
    expect(summary.downloadedCount).toBe(1);

    // Nothing was pushed the other way: the file is gone because the server says so, and it is not
    // re-uploaded, nor is a DELETE sent for a file that is already absent there.
    expect(h.client.uploadFile).not.toHaveBeenCalled();
    expect(h.client.deleteFile).not.toHaveBeenCalled();
  });
});

describe('[SPEC:EAD-2] the deleted file does not come back on the next sync', () => {
  it('is absent from the State-rebuilt listing when the next scan short-circuits', async () => {
    // An empty listing (the bug's condition) over two tracked files, where the re-check confirms one
    // gone and one still there. The survivor is what keeps this vault in the incremental path at all:
    // once State holds no files and there is no sync token, the next session is classified as a FIRST
    // sync and takes the initial-sync route instead — so a listing "rebuilt from State with 0 files"
    // is not a state the engine can be in (that vault shape is covered separately below). With one
    // file left, the short-circuit is reached and the question this test exists to answer can be asked
    // directly: is the deleted path in what the rebuild produces?
    const world: RemoteWorld = {
      listing: [], rootEtag: 'etag-stable', exists: (p) => p === 'keep.md',
    };
    const h = await buildEngine({ 'メモ.md': 'gone body', 'keep.md': 'kept body' }, world);
    await track(h.stateDB, 'メモ.md', 'gone body');
    await track(h.stateDB, 'keep.md', 'kept body');

    await h.sync();
    expect(h.trashed).toEqual(['メモ.md']);
    expect(h.stateDB.getFile('メモ.md')).toBeUndefined();

    const summary = await h.sync();

    // The root ETag has not moved, so the second scan rebuilds the listing from State instead of
    // asking the server for it.
    expect(h.client.getFiles).toHaveBeenCalledTimes(1);
    expect(h.logs.join('\n')).toContain('SHORT-CIRCUIT');
    expect(h.logs.join('\n')).toContain('rebuilt 1 files'); // keep.md only — the deleted path is gone

    // Nothing resurrects it: no second trash, no download, no upload, and it stays out of both the
    // vault and State.
    expect(h.trashed).toEqual(['メモ.md']);
    expect(h.vault['メモ.md']).toBeUndefined();
    expect(h.stateDB.getFile('メモ.md')).toBeUndefined();
    expect(h.client.downloadFile).not.toHaveBeenCalled();
    expect(h.client.uploadFile).not.toHaveBeenCalled();
    expect(summary.uploadedCount).toBe(0);
    expect(summary.downloadedCount).toBe(0);
    expect(summary.errorCount).toBe(0);
  });

  it('is not re-uploaded when emptying the vault sends the next sync down the initial-sync path', async () => {
    // The reporter's exact vault: one file, now deleted on both sides. State is empty afterwards, so
    // the next session is a "first sync" — the one path that could plausibly push the local file back
    // up. It cannot here, because the file is gone locally too; this pins that the fix converges
    // rather than trading a stranded file for a resurrected one.
    const world: RemoteWorld = { listing: [], rootEtag: 'etag-empty', exists: false };
    const h = await buildEngine({ 'メモ.md': 'note body' }, world);
    await track(h.stateDB, 'メモ.md', 'note body');

    await h.sync();
    expect(h.trashed).toEqual(['メモ.md']);

    const summary = await h.sync();

    expect(h.trashed).toEqual(['メモ.md']); // not trashed twice
    expect(h.vault['メモ.md']).toBeUndefined();
    expect(h.stateDB.getFile('メモ.md')).toBeUndefined();
    expect(h.client.uploadFile).not.toHaveBeenCalled();
    expect(summary.uploadedCount).toBe(0);
    expect(summary.errorCount).toBe(0);
  });
});

describe('[SPEC:EAD-3] a file the server still has is kept, whatever the listing said', () => {
  it('keeps it when the re-check says it is there', async () => {
    // A listing that is wrong about a file it omitted. The re-check is the only thing standing between
    // that and a deleted note, so it is asked, and its answer wins over the listing.
    const world: RemoteWorld = { listing: [], rootEtag: 'etag-empty', exists: true };
    const h = await buildEngine({ 'メモ.md': 'note body' }, world);
    await track(h.stateDB, 'メモ.md', 'note body');

    const summary = await h.sync();

    expect(h.client.remoteExists).toHaveBeenCalledWith('メモ.md');
    expect(h.trashed).toEqual([]);
    expect(h.vault['メモ.md']).toBe('note body');
    expect(h.stateDB.getFile('メモ.md')).toBeDefined();
    expect(summary.downloadedCount).toBe(0);
    expect(h.logs.join('\n')).toContain('re-check found it still on server');
  });

  it('keeps it when the server cannot be asked at all', async () => {
    // No answer is not the same as "gone" — the same rule the folder side follows (DTV-1). An
    // undecidable re-check falls back to "present", so an offline or erroring probe can never delete.
    const world: RemoteWorld = { listing: [], rootEtag: 'etag-empty', exists: 'reject' };
    const h = await buildEngine({ 'メモ.md': 'note body' }, world);
    await track(h.stateDB, 'メモ.md', 'note body');

    await h.sync();

    expect(h.client.remoteExists).toHaveBeenCalledWith('メモ.md');
    expect(h.trashed).toEqual([]);
    expect(h.vault['メモ.md']).toBe('note body');
    expect(h.stateDB.getFile('メモ.md')).toBeDefined();
  });
});

describe('[SPEC:EAD-4] the breaker still refuses a vault-sized batch, and local edits are not candidates', () => {
  it('refuses 21 candidates against a limit of 20 without asking the server about any of them', async () => {
    // massDeleteLimit: -1 (the default) means max(20, 20% of tracked) → 20 for 21 tracked files. The
    // breaker fires BEFORE the re-check loop, so a listing that lost the whole vault costs zero extra
    // round-trips and destroys nothing.
    const vault: Record<string, string> = {};
    for (let i = 0; i < 21; i++) vault[`note-${i}.md`] = `body ${i}`;
    const world: RemoteWorld = { listing: [], rootEtag: 'etag-empty', exists: false };
    const h = await buildEngine(vault, world);
    for (let i = 0; i < 21; i++) await track(h.stateDB, `note-${i}.md`, `body ${i}`);

    const summary = await h.sync();

    expect(h.client.remoteExists).not.toHaveBeenCalled();
    expect(h.trashed).toEqual([]);
    expect(h.stateDB.getAllFiles()).toHaveLength(21);
    expect(summary.errors.map(e => e.path)).toContain('(mass-delete breaker)');
    expect(h.logs.join('\n')).toContain('exceeds safety limit (20)');
  });

  it('leaves a locally edited file out of the candidate set and uploads it instead', async () => {
    // The edit is the whole point: absence deletion compares real content against the recorded base,
    // never mtime, so a file whose body has moved on is protected and pushed up rather than trashed —
    // the resurrection side of a delete/edit race, which the user still has locally.
    const world: RemoteWorld = { listing: [], rootEtag: 'etag-empty', exists: true };
    const h = await buildEngine({ 'メモ.md': 'edited body, longer than the base' }, world);
    await track(h.stateDB, 'メモ.md', 'base body'); // recorded hash/size ≠ what is on disk now

    const summary = await h.sync();

    expect(h.client.uploadFile).toHaveBeenCalledTimes(1);
    expect(h.client.uploadFile).toHaveBeenCalledWith('メモ.md', expect.anything(), BASE_MTIME, expect.anything());
    expect(summary.uploadedCount).toBe(1);

    // Nothing was trashed, and the file is still tracked — now against the body that was uploaded.
    expect(h.trashed).toEqual([]);
    expect(h.vault['メモ.md']).toBe('edited body, longer than the base');
    expect(h.stateDB.getFile('メモ.md')!.localHash).toBe(await sha256(toBuf('edited body, longer than the base')));
    expect(summary.errorCount).toBe(0);
  });
});
