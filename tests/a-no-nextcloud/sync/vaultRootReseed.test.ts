// [SPEC:VRR-1] [SPEC:VRR-2] [SPEC:VRR-3] [SPEC:VRR-4] [SPEC:VRR-5]
// specs/083-empty-listing-absence-delete/contracts/vault-root.md (C-1 / C-3), FR-007..FR-013.
//
// The vault folder itself disappearing from the server is NOT the same event as the vault folder
// being there and holding nothing, and the whole feature turns on keeping those two apart.
//
// An empty listing is the server's own statement about the contents of a folder it still has: every
// tracked file is genuinely gone from it, so absence-based deletion is the right reading. A 404 on
// the root says nothing whatsoever about any individual file — the folder that would have answered
// the question is not there to answer it. Collapsing the 404 to `[]` (what the code did before this
// feature) therefore produces the worst of both worlds: unchanged files are not upload candidates,
// deletions are refused by the guards, and every file in the vault is left stranded — present
// locally, absent remotely, and never reconciled. The user cannot fix it by hand either, because the
// remote path was derived by the plugin from the vault name and is not something they chose.
//
// So the engine re-creates the folder and re-seeds it from local, and MKCOL is what makes that safe
// to do. MKCOL is the proof step, not a convenience:
//   - 201 'created' — the folder really was absent. The 404 listing was telling the truth, nothing
//     on the server can be a deletion record any more, and local is the only surviving copy. Reset
//     the tracking index and re-run the first-sync path: upload every file, MKCOL every folder
//     (empty ones included), delete NOTHING locally.
//   - 405 'exists'  — the folder is there after all, so the listing that reported 404 was wrong. A
//     wrong listing is a failed listing: change nothing at all (no reset, no deletion, no upload),
//     record the error, and let the next sync do a real scan.
//   - anything else — no proof either way, so likewise change nothing.
// The asymmetry is deliberate. Re-seeding on a false 404 would wipe the tracking index while the
// remote state is unknown; refusing to re-seed on a true 404 merely postpones the repair by one sync.
//
// These tests drive the REAL SyncEngine (syncManual) against a REAL StateDB, so the routing decision
// under test — first sync (State empty) vs. incremental (State non-empty) — is made by the engine
// itself, not by the test. Only the WebDAV client, the local adapter and the Obsidian app are
// doubles. The client double is a small in-memory server rather than a set of canned answers, which
// is what lets VRR-1 assert the thing that actually matters to a user: after the re-seed, a second
// sync moves nothing (up=0 del=0) because both sides genuinely agree again.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import {
  DEFAULT_SETTINGS, NetworkError, NextcloudFeatures, RemoteDirInfo, RemoteFileInfo,
  RemoteRootMissingError, VaultRootOutcome,
} from '../../../src/types';
import { sha256 } from '../../../src/util/hash';
import { TFile, TFolder } from '../support/obsidian';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
/** Fixed local mtime, far outside the signature safety window of both `now` and the last sync. */
const MTIME = 1_000;

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

interface RemoteEntry { body: string; checksum: string; mtime: number }

/**
 * A minimal in-memory server. It models exactly one thing beyond ordinary storage: `rootMissing`,
 * which makes a root listing answer 404 the way a deleted vault folder does, and which any write
 * that materialises the folder again clears — `createVaultRoot()` returning 'created', an upload
 * (whose client creates missing ancestors), or a MKCOL. That coupling is the point: a test cannot
 * assert "the second listing succeeded" without the engine having actually created the folder first.
 */
function makeClient(opts: { rootMissing: boolean; vaultRoot: VaultRootOutcome | Error }) {
  const files = new Map<string, RemoteEntry>();
  const dirs = new Set<string>();
  let rootMissing = opts.rootMissing;
  let version = 0;
  const touched = (): void => { rootMissing = false; version++; };

  const infoOf = (path: string, e: RemoteEntry): RemoteFileInfo => ({
    path, fileId: `id:${path}`, checksum: e.checksum, etag: null,
    size: enc.encode(e.body).length, lastModified: e.mtime,
  });
  const under = (parent: string, p: string): boolean => p.startsWith(`${parent}/`);

  return {
    files, dirs,
    getRootEtag: jest.fn(async (): Promise<string | null> => (rootMissing ? null : `root-etag-${version}`)),
    getFiles: jest.fn(async (path: string): Promise<RemoteFileInfo[]> => {
      // C-1: only the ROOT distinguishes 404 from "empty"; a missing subpath stays an empty listing.
      if (path === '' && rootMissing) throw new RemoteRootMissingError();
      return [...files.entries()].map(([p, e]) => infoOf(p, e));
    }),
    // Nextcloud does not support the sync-collection REPORT (spec §18 F1), so every sync takes the
    // full-scan branch of incrementalSync — which is the branch this feature changes.
    getSyncToken: jest.fn(async (): Promise<string | null> => null),
    getChanges: jest.fn(async () => { throw new Error('getChanges must not be reached (no sync token)'); }),
    createVaultRoot: jest.fn(async (): Promise<VaultRootOutcome> => {
      if (opts.vaultRoot instanceof Error) throw opts.vaultRoot;
      if (opts.vaultRoot === 'created') touched();
      return opts.vaultRoot;
    }),
    getDirectories: jest.fn(async (): Promise<RemoteDirInfo[]> =>
      [...dirs].map((p) => ({ path: p, fileId: `id:${p}`, etag: null, lastModified: 0 }))),
    createDirectory: jest.fn(async (p: string) => { dirs.add(p); touched(); }),
    uploadFile: jest.fn(async (
      p: string, data: ArrayBuffer, mtime?: number, o?: { precomputedSha256?: string },
    ) => {
      files.set(p, { body: dec.decode(data), checksum: o?.precomputedSha256 ?? await sha256(data), mtime: mtime ?? MTIME });
      touched();
    }),
    downloadFile: jest.fn(async (p: string) => toBuf(files.get(p)?.body ?? '')),
    statFile: jest.fn(async (p: string) => (files.has(p) ? infoOf(p, files.get(p)!) : null)),
    remoteExists: jest.fn(async (p: string) => files.has(p) || dirs.has(p)),
    deleteFile: jest.fn(async (p: string) => { files.delete(p); version++; }),
    deleteCollection: jest.fn(async (p: string) => { dirs.delete(p); version++; }),
    isRemoteDirEmpty: jest.fn(async (p: string) =>
      ![...files.keys()].some((f) => under(p, f)) && ![...dirs].some((d) => under(p, d))),
    recalcChecksum: jest.fn(async (p: string) => files.get(p)?.checksum ?? null),
  };
}

type FakeClient = ReturnType<typeof makeClient>;

/** In-memory local vault. `folders` carries EMPTY folders too — they are first-class here. */
function makeLocalAdapter(files: Record<string, string>) {
  const sizeOf = (p: string): number => enc.encode(files[p]).length;
  return {
    files,
    listVaultFiles: jest.fn(() => Object.keys(files).map((p) => ({ path: p, size: sizeOf(p), mtime: MTIME }))),
    list: jest.fn(async () => ({ files: [] as string[], folders: [] as string[] })),
    stat: jest.fn(async (p: string) => (p in files ? { size: sizeOf(p), mtime: MTIME } : null)),
    exists: jest.fn(async (p: string) => p in files),
    read: jest.fn(async (p: string) => files[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(files[p] ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    setMtime: jest.fn(async () => undefined),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
  };
}

interface HarnessOptions {
  /** Local vault contents (path → body). */
  localFiles: Record<string, string>;
  /** Local folders, including empty ones. */
  localFolders: string[];
  /** Whether StateDB already tracks the vault (false = the very first sync). */
  tracked: boolean;
  /** Whether the server's vault folder is gone (root listing answers 404). */
  rootMissing: boolean;
  /** What `createVaultRoot()` answers, or an error it rejects with. */
  vaultRoot: VaultRootOutcome | Error;
}

async function buildHarness(o: HarnessOptions) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const local = makeLocalAdapter({ ...o.localFiles });
  const client = makeClient({ rootMissing: o.rootMissing, vaultRoot: o.vaultRoot });

  if (o.tracked) {
    // A vault this device has synced before: every file and folder is recorded, and each file's
    // post-write stat signature matches disk, so the engine's fast-path reads them as UNCHANGED —
    // which is precisely why the old "404 → []" reading stranded them (not upload candidates, and
    // the deletion guards refuse to act on an empty listing).
    for (const [path, body] of Object.entries(o.localFiles)) {
      const hash = await sha256(toBuf(body));
      const size = enc.encode(body).length;
      stateDB.setFile({
        path, localHash: hash, remoteId: hash, idType: 'sha256', size, mtime: MTIME,
        remoteFileId: `id:${path}`, isConflicted: false, localMtime: MTIME, localSize: size,
      });
    }
    for (const path of o.localFolders) stateDB.setDir({ path, remoteFileId: `id:${path}` });
  }

  const trashed: string[] = [];
  const app = {
    vault: {
      adapter: {
        mkdir: jest.fn(async () => undefined),
        exists: jest.fn(async (p: string) => p in local.files),
        remove: jest.fn(async (p: string) => { delete local.files[p]; }),
      },
      getAllFolders: () => o.localFolders.map((p) => new TFolder(p)),
      getAbstractFileByPath: (p: string) => {
        if (o.localFolders.includes(p)) return new TFolder(p);
        return p in local.files ? new TFile(p) : null;
      },
    },
    fileManager: {
      trashFile: jest.fn(async (f: TFile | TFolder) => { trashed.push(f.path); }),
    },
  };

  const features: NextcloudFeatures = {
    isNextcloud: true, version: '30', hasChecksums: true, hasFilesLocking: false,
    hasBulkUpload: false, syncToken: null,
  };
  const createClient = jest.fn(async () => ({ client, features }));
  const logger = { log: jest.fn() };
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };

  const engine = new SyncEngine({
    app, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
    localAdapter: local, stateDB, statusBar, webdavFactory: { createClient }, logger,
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  return {
    engine, stateDB, client, local, trashed,
    logs: (): string => logger.log.mock.calls.map((c) => String(c[0])).join('\n'),
  };
}

/** A tracked two-file vault with one subfolder and one EMPTY folder. */
const TRACKED_VAULT = {
  localFiles: { 'a.md': 'body of a\n', 'sub/b.md': 'body of b\n' },
  localFolders: ['sub', 'empty'],
  tracked: true,
};

const paths = (m: jest.Mock): string[] => m.mock.calls.map((c) => String(c[0])).sort();
const trackedPaths = (db: StateDB): string[] => db.getAllFiles().map((f) => f.path).sort();

beforeEach(() => {
  // testEnvironment is 'node'; isBlockedByWifiOnly reads navigator.connection. syncOnWifiOnly=false
  // short-circuits before it, but guard the global so environments without `navigator` don't throw.
  (globalThis as { navigator?: unknown }).navigator ??= {};
});

describe('[SPEC:VRR-1] a tracked vault whose folder vanished is re-created and re-seeded from local', () => {
  it('creates the folder, resets tracking, uploads every file and folder, and deletes nothing locally', async () => {
    const h = await buildHarness({ ...TRACKED_VAULT, rootMissing: true, vaultRoot: 'created' });

    await h.engine.syncManual({ manual: true });

    // The 404 was answered by asking the server to create the folder — the one action that can tell
    // a real absence (201) from a lying listing (405).
    expect(h.client.createVaultRoot).toHaveBeenCalledTimes(1);
    expect(h.logs()).toContain('re-seeding from local');

    // Local is the surviving copy, so it is pushed in full: both files, both folders (including the
    // empty one, which no file path would imply).
    expect(h.client.uploadFile).toHaveBeenCalledTimes(2);
    expect(paths(h.client.uploadFile)).toEqual(['a.md', 'sub/b.md']);
    expect(paths(h.client.createDirectory)).toEqual(['empty', 'sub']);

    // FR-009: nothing is removed from the vault. A re-seed is a push, never a reconciliation.
    expect(h.trashed).toEqual([]);
    expect(Object.keys(h.local.files).sort()).toEqual(['a.md', 'sub/b.md']);

    // The tracking index was rebuilt (reset + first-sync path), not merely left alone.
    expect(trackedPaths(h.stateDB)).toEqual(['a.md', 'sub/b.md']);
    expect(h.stateDB.getAllDirs().map((d) => d.path).sort()).toEqual(['empty', 'sub']);

    await h.stateDB.flush();
  });

  it('converges: the very next sync moves nothing', async () => {
    // The re-seed is only worth anything if it lands both sides on the same state. A second sync that
    // still uploads (or, worse, deletes) would mean the rebuilt index disagrees with what was pushed.
    const h = await buildHarness({ ...TRACKED_VAULT, rootMissing: true, vaultRoot: 'created' });

    await h.engine.syncManual({ manual: true });
    expect(h.client.uploadFile).toHaveBeenCalledTimes(2);

    await h.engine.syncManual({ manual: true });

    const second = h.engine.getLastSessionSummary()!;
    expect(second.uploadedCount).toBe(0);
    expect(second.downloadedCount).toBe(0);
    expect(second.deletedCount).toBe(0);
    expect(second.errorCount).toBe(0);
    expect(h.client.uploadFile).toHaveBeenCalledTimes(2); // still just the re-seed's two
    expect(h.client.createVaultRoot).toHaveBeenCalledTimes(1); // the folder is there now
    expect(h.trashed).toEqual([]);

    await h.stateDB.flush();
  });
});

describe('[SPEC:VRR-2] MKCOL 405 means the listing lied — nothing is changed', () => {
  it('does not reset tracking, upload, or delete, and records the failure instead', async () => {
    const h = await buildHarness({ ...TRACKED_VAULT, rootMissing: true, vaultRoot: 'exists' });
    const before = trackedPaths(h.stateDB);

    await h.engine.syncManual({ manual: true });

    expect(h.client.createVaultRoot).toHaveBeenCalledTimes(1);
    expect(h.logs()).toContain('treating the listing as failed');
    expect(h.logs()).not.toContain('re-seeding from local');

    // FR-010: a session that cannot trust its listing performs NO destructive work at all.
    expect(h.client.uploadFile).not.toHaveBeenCalled();
    expect(h.client.deleteFile).not.toHaveBeenCalled();
    expect(h.client.deleteCollection).not.toHaveBeenCalled();
    expect(h.trashed).toEqual([]);
    expect(trackedPaths(h.stateDB)).toEqual(before);
    expect(h.stateDB.getAllDirs().map((d) => d.path).sort()).toEqual(['empty', 'sub']);

    const summary = h.engine.getLastSessionSummary()!;
    expect(summary.errors).toHaveLength(1);
    // No root ETag was stored (the listing never completed), so the next sync really re-scans
    // instead of short-circuiting on State — that is what makes "retry next sync" true.
    expect(h.stateDB.getRemoteRootEtag()).toBeNull();

    await h.stateDB.flush();
  });
});

describe('[SPEC:VRR-3] a failed MKCOL is treated exactly like a 405 — no proof, no changes', () => {
  it('leaves tracking and both sides untouched when createVaultRoot rejects', async () => {
    // FR-011: 403 / 5xx / offline all say the same thing — the server did not tell us whether the
    // folder is there. Only a 201 licenses the reset, so everything else must stop here.
    const h = await buildHarness({
      ...TRACKED_VAULT, rootMissing: true, vaultRoot: new NetworkError(403, '', 'MKCOL'),
    });
    const before = trackedPaths(h.stateDB);

    await h.engine.syncManual({ manual: true });

    expect(h.client.createVaultRoot).toHaveBeenCalledTimes(1);
    expect(h.logs()).not.toContain('re-seeding from local');
    expect(h.client.uploadFile).not.toHaveBeenCalled();
    expect(h.client.deleteFile).not.toHaveBeenCalled();
    expect(h.client.deleteCollection).not.toHaveBeenCalled();
    expect(h.trashed).toEqual([]);
    expect(trackedPaths(h.stateDB)).toEqual(before);

    const summary = h.engine.getLastSessionSummary()!;
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].message).toContain('403');

    await h.stateDB.flush();
  });
});

describe('[SPEC:VRR-4] the first sync of an untracked vault is unaffected', () => {
  it('reads the missing folder as an empty listing and uploads everything, without a re-seed', async () => {
    // FR-012 regression guard. With nothing tracked there is no state to protect and no deletion the
    // absence could imply, so the historical behaviour still applies: treat it as empty and let the
    // first upload create the hierarchy. Routing this through reseedFromLocal instead would reset an
    // already-empty index and fire a Notice about a repair that never happened.
    const h = await buildHarness({
      localFiles: TRACKED_VAULT.localFiles, localFolders: TRACKED_VAULT.localFolders,
      tracked: false, rootMissing: true, vaultRoot: 'created',
    });

    await h.engine.syncManual({ manual: true });

    expect(h.client.createVaultRoot).not.toHaveBeenCalled();
    expect(paths(h.client.uploadFile)).toEqual(['a.md', 'sub/b.md']);
    expect(trackedPaths(h.stateDB)).toEqual(['a.md', 'sub/b.md']);
    expect(h.trashed).toEqual([]);

    await h.stateDB.flush();
  });
});

describe('[SPEC:VRR-5] an empty listing is not a missing folder', () => {
  it('never asks to create the vault folder when the server answered 207 with no children', async () => {
    // The separation this whole feature rests on, asserted from the other side: a folder that exists
    // and holds nothing is a listing the engine must believe. Whatever it then decides about the
    // tracked files (that is absence-deletion's business, covered by the EAD tests) it must not
    // reach for the repair path — a vault folder that is present needs no creating.
    const h = await buildHarness({ ...TRACKED_VAULT, rootMissing: false, vaultRoot: 'created' });

    await h.engine.syncManual({ manual: true });

    expect(h.client.getFiles).toHaveBeenCalledWith('');
    expect(h.client.createVaultRoot).not.toHaveBeenCalled();
    expect(h.logs()).not.toContain('re-seeding from local');

    await h.stateDB.flush();
  });
});

/** Keeps the client double honest: the engine must find every method it reaches for. */
describe('client double sanity', () => {
  it('exposes the surface the full-sync path uses', async () => {
    const h = await buildHarness({ ...TRACKED_VAULT, rootMissing: false, vaultRoot: 'exists' });
    const client: FakeClient = h.client;
    for (const m of [
      'getRootEtag', 'getFiles', 'getSyncToken', 'getChanges', 'createVaultRoot', 'getDirectories',
      'createDirectory', 'uploadFile', 'downloadFile', 'statFile', 'remoteExists', 'deleteFile',
      'deleteCollection', 'isRemoteDirEmpty', 'recalcChecksum',
    ] as const) {
      expect(typeof client[m]).toBe('function');
    }
  });
});
