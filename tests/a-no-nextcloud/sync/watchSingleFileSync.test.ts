// [SPEC:WSF-2] [SPEC:WSF-3] [SPEC:WSF-4] [SPEC:WSF-8]
// specs/064-watch-single-file-conflict/contracts/watch-single-file-sync.md (C-1, C-6)
//
// Feature 064 (GitHub issue #23 regression): "Sync on file change" used to PUT the local body
// straight to the server with no PROPFIND and no If-Match, so an edit made on another device since
// the last sync was silently overwritten. `SyncEngine.syncSingleFile` now fetches the remote state
// first and hands it to the SAME classifier the full sync uses (`processRemoteFile`).
//
// These tests drive the REAL `SyncEngine.syncSingleFile` end to end (client double + in-memory local
// adapter), exactly as tests/a-no-nextcloud/sync/untrackedBothSides.test.ts does for
// `processRemoteFile`. They deliberately do NOT reimplement the C-1 classification table: the point
// of this suite is to prove the real engine follows it, not to check a parallel copy of the logic.
import { DataAdapter, Notice } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import {
  DEFAULT_SETTINGS, FileState, NetworkError, PreconditionFailedError, RemoteFileInfo,
} from '../../../src/types';
import { sha256 } from '../../../src/util/hash';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const hashOf = (s: string): Promise<string> => sha256(toBuf(s));
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
 * In-memory local vault. `files` maps path -> current content; a path that is absent means the file
 * does not exist locally. mtimes are fixed per path so the deterministic strategies are predictable.
 */
function makeLocalAdapter(files: Record<string, string>, mtimes: Record<string, number> = {}) {
  const mtimeOf = (p: string): number => mtimes[p] ?? 1_000;
  return {
    files,
    stat: jest.fn(async (p: string) =>
      p in files ? { size: enc.encode(files[p]).length, mtime: mtimeOf(p) } : null),
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
 * Row 6's only path into the engine (per the contract's footnote): `syncSingleFile` decides "content
 * changed" from its OWN read before ever asking the remote, then hands off to `processRemoteFile`,
 * which re-reads and re-hashes independently. The only way the second read can find "actually
 * unchanged from base" after the first read found "changed" is a real race — the on-disk content
 * reverted between the two reads (e.g. an editor / format-on-save round-trip completing mid-debounce).
 * `readBinary` here serves `tempBody` once (the first, "changed" read) and `finalBody` afterwards.
 */
function makeRacyLocalAdapter(path: string, tempBody: string, finalBody: string, mtime = 1_000) {
  const files: Record<string, string> = { [path]: tempBody };
  let readBinaryCalls = 0;
  return {
    files,
    stat: jest.fn(async (p: string) =>
      p in files ? { size: enc.encode(files[p]).length, mtime } : null),
    exists: jest.fn(async (p: string) => p in files),
    read: jest.fn(async (p: string) => (p === path ? finalBody : files[p] ?? '')),
    readBinary: jest.fn(async (p: string) => {
      if (p !== path) return toBuf(files[p] ?? '');
      readBinaryCalls += 1;
      return toBuf(readBinaryCalls === 1 ? tempBody : finalBody);
    }),
    atomicWrite: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    setMtime: jest.fn(),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
  };
}

async function buildEngine(
  localAdapter: Record<string, unknown>,
  client: Record<string, unknown>,
  settings: Partial<typeof DEFAULT_SETTINGS> = {},
  uploadStrategy: Record<string, unknown> = { upload: jest.fn(async () => 'uploaded' as const) },
) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const baseStore = {
    get: jest.fn(() => undefined), set: jest.fn(), delete: jest.fn(),
    requestSave: jest.fn(), flush: jest.fn(async () => undefined),
  };
  const statusBar = { setStatus: jest.fn() };
  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS, ...settings },
    localAdapter, stateDB, baseStore, statusBar, webdavFactory: {},
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);
  // Bypass ensureClient()'s webdavFactory.createClient() call the same way
  // untrackedBothSides.test.ts bypasses it for processRemoteFile: pre-seed both fields it guards on
  // (`!this.client || !this.features`) so syncSingleFile's `ensureClient()` call is a no-op.
  (engine as unknown as { client: unknown }).client = client;
  (engine as unknown as { features: unknown }).features = {
    isNextcloud: true, version: '30.0.0', hasChecksums: true, hasFilesLocking: false,
    hasBulkUpload: false, syncToken: null,
  };
  (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = uploadStrategy;
  return { engine, stateDB, baseStore, statusBar };
}

const remoteOf = (path: string, body: string, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo =>
  ({
    path, fileId: 'f1', checksum: null, etag: 'remote-etag',
    size: enc.encode(body).length, lastModified: 9_000, ...over,
  });

/** The mock Notice records every constructed toast on a static `instances` array (test double only). */
const notices = (): { message: string }[] =>
  (Notice as unknown as { instances: { message: string }[] }).instances;

/** Record `path` as tracked (previously converged) with `body` on both sides. */
function seedTracked(stateDB: StateDB, path: string, body: string, hash: string): void {
  const fs: FileState = {
    path, localHash: hash, remoteId: hash, idType: 'sha256',
    size: enc.encode(body).length, mtime: 1_000, remoteFileId: 'f1', isConflicted: false,
  };
  stateDB.setFile(fs);
}

beforeEach(() => { notices().length = 0; });

describe('[SPEC:WSF-2] C-1 row 2 — no local file: syncSingleFile does nothing and never touches the network', () => {
  it('[SPEC:WSF-2] returns without calling statFile when the local file is absent', async () => {
    const local = makeLocalAdapter({});
    const client = { statFile: jest.fn(async () => null) };
    const { engine } = await buildEngine(local, client);

    await engine.syncSingleFile('missing.md');

    expect(client.statFile).not.toHaveBeenCalled();
    expect(notices().length).toBe(0);
  });
});

describe('[SPEC:WSF-2] C-1 row 3 — local content unchanged from base: zero communication (FR-006)', () => {
  it('[SPEC:WSF-2] does not call statFile at all when the saved content equals the recorded base', async () => {
    const BODY = 'nothing actually changed\n';
    const hash = await hashOf(BODY);
    const local = makeLocalAdapter({ 'note.md': BODY });
    const client = { statFile: jest.fn(async () => null) };
    const { engine, stateDB } = await buildEngine(local, client);
    seedTracked(stateDB, 'note.md', BODY, hash);

    await engine.syncSingleFile('note.md');

    // FR-006: a modify event with no real content change must produce ZERO network calls.
    expect(client.statFile).not.toHaveBeenCalled();
    expect(notices().length).toBe(0);
  });
});

describe('[SPEC:WSF-3] C-1 row 4 — untracked local file, remote absent: uploaded as new with no precondition', () => {
  it('[SPEC:WSF-3] uploads via statFile → null → uploadFile, with a null If-Match (new resource)', async () => {
    const BODY = 'brand new local note\n';
    const local = makeLocalAdapter({ 'new.md': BODY });
    const client = { statFile: jest.fn(async () => null) };
    const upload = jest.fn(async (
      _client: unknown, _path: string, _data: ArrayBuffer, _mtime?: number,
      _opts?: { ifMatchEtag?: string | null },
    ) => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });

    await engine.syncSingleFile('new.md');

    expect(client.statFile).toHaveBeenCalledWith('new.md');
    expect(upload).toHaveBeenCalledTimes(1);
    const [, path, , , uploadOpts] = upload.mock.calls[0];
    expect(path).toBe('new.md');
    expect(uploadOpts?.ifMatchEtag).toBeNull(); // no precondition against a non-existent resource

    const state = stateDB.getFile('new.md');
    expect(state?.remoteId).toBe(await hashOf(BODY));
    expect(state?.isConflicted).toBe(false);
    expect(notices().length).toBe(0); // plain upload: silent (C-6)
  });
});

describe('[SPEC:WSF-3] C-1 row 5 — local-only change, remote unchanged: uploaded with the remote etag as If-Match', () => {
  it('[SPEC:WSF-3] passes the known remote etag as ifMatchEtag (lost-update guard)', async () => {
    const SYNCED = 'v1\n';
    const EDITED = 'v1 plus a local edit\n';
    const syncedHash = await hashOf(SYNCED);
    const remoteEtag = 'etag-v1-current';
    const local = makeLocalAdapter({ 'tracked.md': EDITED });
    const client = {
      statFile: jest.fn(async () => remoteOf('tracked.md', SYNCED, { checksum: syncedHash, etag: remoteEtag })),
    };
    const upload = jest.fn(async (
      _client: unknown, _path: string, _data: ArrayBuffer, _mtime?: number,
      _opts?: { ifMatchEtag?: string | null },
    ) => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    seedTracked(stateDB, 'tracked.md', SYNCED, syncedHash);

    await engine.syncSingleFile('tracked.md');

    expect(client.statFile).toHaveBeenCalledWith('tracked.md');
    expect(upload).toHaveBeenCalledTimes(1);
    const [, , , , uploadOpts] = upload.mock.calls[0];
    expect(uploadOpts?.ifMatchEtag).toBe(remoteEtag);
    expect(notices().length).toBe(0); // plain upload: silent (C-6)
  });
});

describe('[SPEC:WSF-4] C-1 row 6 — local reverted to base after the initial hash, remote changed: downloaded', () => {
  it('[SPEC:WSF-4] fetches and writes the remote body, with no upload attempted', async () => {
    const BASE_BODY = 'converged content\n';
    const TEMP_BODY = 'momentarily different (reverted before classification)\n';
    const REMOTE_BODY = 'remote changed content\n';
    const baseHash = await hashOf(BASE_BODY);
    const remoteChecksum = await hashOf(REMOTE_BODY);
    const local = makeRacyLocalAdapter('note.md', TEMP_BODY, BASE_BODY);
    const client = {
      statFile: jest.fn(async () => remoteOf('note.md', REMOTE_BODY, { checksum: remoteChecksum })),
      downloadFile: jest.fn(async () => toBuf(REMOTE_BODY)),
    };
    const upload = jest.fn(async () => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    seedTracked(stateDB, 'note.md', BASE_BODY, baseHash);

    await engine.syncSingleFile('note.md');

    expect(client.downloadFile).toHaveBeenCalledWith('note.md');
    expect(local.files['note.md']).toBe(REMOTE_BODY);
    expect(upload).not.toHaveBeenCalled();
    expect(notices().length).toBe(0); // plain download: silent (C-6)
  });
});

describe('[SPEC:WSF-4] C-1 row 7 — both sides changed a tracked .md: merged, both edits preserved', () => {
  it('[SPEC:WSF-4] the resolved body contains both the local and the remote addition and the merge is pushed', async () => {
    const OLD = 'shared line\n';
    const LOCAL = 'shared line\n\nlocal addition\n';
    const REMOTE = 'shared line\n\nremote addition\n';
    const oldHash = await hashOf(OLD);
    const remoteChecksum = await hashOf(REMOTE);
    const local = makeLocalAdapter({ 'note.md': LOCAL });
    const client = {
      statFile: jest.fn(async () => remoteOf('note.md', REMOTE, { checksum: remoteChecksum, etag: 'e2' })),
      downloadFile: jest.fn(async () => toBuf(REMOTE)),
    };
    const upload = jest.fn(async () => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    seedTracked(stateDB, 'note.md', OLD, oldHash);

    await engine.syncSingleFile('note.md');

    // GitHub issue #23's core assertion: neither side's edit was silently dropped.
    expect(local.files['note.md']).toContain('local addition');
    expect(local.files['note.md']).toContain('remote addition');
    expect(upload).toHaveBeenCalled(); // the merge is pushed so both sides converge

    // C-6: a resolved conflict (clean merge included) must notify, naming the path.
    expect(notices().length).toBe(1);
    expect(notices()[0].message).toContain('note.md');
  });
});

describe('[SPEC:WSF-4] C-1 row 8 — upload race (412 If-Match failure): falls back to conflict resolution, never overwrites', () => {
  it('[SPEC:WSF-4] retries as a merge instead of losing either side when the PUT reports a precondition failure', async () => {
    const OLD = 'shared line\n';
    const LOCAL = 'shared line\n\nlocal addition\n';
    const REMOTE_NOW = 'shared line\n\nremote addition that landed mid-sync\n';
    const oldHash = await hashOf(OLD);
    const local = makeLocalAdapter({ 'note.md': LOCAL });
    // statFile still reports the OLD (base-matching) remote state — the change on the server landed
    // AFTER the PROPFIND but BEFORE the PUT, which is exactly what turns the PUT into a 412.
    const client = {
      statFile: jest.fn(async () => remoteOf('note.md', OLD, { checksum: oldHash, etag: 'e-old' })),
      downloadFile: jest.fn(async () => toBuf(REMOTE_NOW)),
    };
    let uploadCalls = 0;
    const upload = jest.fn(async () => {
      uploadCalls += 1;
      if (uploadCalls === 1) throw new PreconditionFailedError('note.md');
      return 'uploaded' as const;
    });
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    seedTracked(stateDB, 'note.md', OLD, oldHash);

    await expect(engine.syncSingleFile('note.md')).resolves.toBeUndefined(); // must not throw

    expect(upload).toHaveBeenCalledTimes(2); // failed direct PUT, then the merge push
    expect(client.downloadFile).toHaveBeenCalledWith('note.md'); // fetched to resolve, not skipped
    expect(local.files['note.md']).toContain('local addition'); // local edit not overwritten
    expect(local.files['note.md']).toContain('remote addition that landed mid-sync'); // remote edit not lost

    expect(notices().length).toBe(1); // resolved as a conflict → C-6 notifies
  });
});

describe('[SPEC:WSF-4] C-1 row 9 — statFile fails with a NetworkError: local kept intact, queued for retry', () => {
  it('[SPEC:WSF-4] leaves the local edit untouched, does not throw, and queues the path for retry', async () => {
    const OLD = 'v1\n';
    const EDITED = 'v1 plus an edit made while offline\n';
    const oldHash = await hashOf(OLD);
    const local = makeLocalAdapter({ 'offline.md': EDITED });
    const client = { statFile: jest.fn(async () => { throw new NetworkError(503, 'unavailable'); }) };
    const { engine, stateDB } = await buildEngine(local, client);
    seedTracked(stateDB, 'offline.md', OLD, oldHash);

    await expect(engine.syncSingleFile('offline.md')).resolves.toBeUndefined(); // FR-009: never throws out

    expect(local.files['offline.md']).toBe(EDITED); // local edit survives untouched
    const retryQueue = (engine as unknown as { retryQueue: string[] }).retryQueue;
    expect(retryQueue).toContain('offline.md');

    // C-6: a failed single-file sync must notify, naming the path.
    expect(notices().length).toBe(1);
    expect(notices()[0].message).toContain('offline.md');
  });
});

describe('[SPEC:WSF-4] C-1 row 10 — untracked file present on both sides (feature 063 rule, driven via watch mode)', () => {
  it('[SPEC:WSF-4] seeds state without transferring when the content already matches (no base, same bytes)', async () => {
    const BODY = 'already identical on both sides\n';
    const checksum = await hashOf(BODY);
    const local = makeLocalAdapter({ 'same.md': BODY });
    const client = {
      statFile: jest.fn(async () => remoteOf('same.md', BODY, { checksum })),
      downloadFile: jest.fn(async () => toBuf(BODY)),
    };
    const upload = jest.fn(async () => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });

    await engine.syncSingleFile('same.md');

    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    const seeded = stateDB.getFile('same.md');
    expect(seeded?.remoteId).toBe(checksum);
    expect(seeded?.isConflicted).toBe(false);
    expect(notices().length).toBe(0); // no transfer, no conflict: silent (C-6)
  });

  it('[SPEC:WSF-4] resolves as a conflict (both edits preserved) when the untracked content differs', async () => {
    const LOCAL = 'shared\n\nlocal only\n';
    const REMOTE = 'shared\n\nremote only\n';
    const local = makeLocalAdapter({ 'note2.md': LOCAL });
    const client = {
      statFile: jest.fn(async () => remoteOf('note2.md', REMOTE, { checksum: await hashOf(REMOTE) })),
      downloadFile: jest.fn(async () => toBuf(REMOTE)),
    };
    const { engine } = await buildEngine(local, client);

    await engine.syncSingleFile('note2.md');

    expect(local.files['note2.md']).toContain('local only');
    expect(local.files['note2.md']).toContain('remote only');
    expect(notices().length).toBe(1); // resolved as a conflict → C-6 notifies
  });
});

// C-6, deterministic-strategy row: a conflict on a NON-markdown file settles via `otherFileStrategy`
// (default latest-mtime), which reports itself as a plain upload/download — no mergedCount, no
// conflictedCount. That is the outcome where one side's content is dropped outright, so it must NOT
// be silent. The engine detects it from the handleConflict entry count rather than the counters.
describe('[SPEC:WSF-8] C-6: a conflict settled by a deterministic strategy still notifies', () => {
  it('notifies when both sides changed a non-mergeable file and the newer side won', async () => {
    const LOCAL = 'local body';
    const REMOTE = 'remote body';
    // Local mtime is the newer one, so latest-mtime keeps local and the remote body is discarded.
    const local = makeLocalAdapter({ 'data.bin': LOCAL }, { 'data.bin': 50_000 });
    const client = {
      statFile: jest.fn(async () => remoteOf('data.bin', REMOTE, { lastModified: 10_000 })),
      downloadFile: jest.fn(async () => toBuf(REMOTE)),
    };
    const upload = jest.fn(async () => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    seedTracked(stateDB, 'data.bin', 'base body', await hashOf('base body'));

    await engine.syncSingleFile('data.bin');

    // Local won on mtime: the local body is pushed and the remote body is gone.
    expect(upload).toHaveBeenCalled();
    expect(local.files['data.bin']).toBe(LOCAL);
    // The summary counts this as an upload, so only the conflict-encounter delta can surface it.
    expect(notices().length).toBe(1);
    expect(notices()[0].message).toContain('data.bin');
  });

  it('stays silent for a plain upload where no conflict was ever detected', async () => {
    const local = makeLocalAdapter({ 'plain.bin': 'edited body' }, { 'plain.bin': 50_000 });
    const baseHash = await hashOf('base body');
    const client = {
      statFile: jest.fn(async () => remoteOf('plain.bin', 'base body', { checksum: baseHash })),
      downloadFile: jest.fn(async () => toBuf('base body')),
    };
    const upload = jest.fn(async () => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    seedTracked(stateDB, 'plain.bin', 'base body', baseHash);

    await engine.syncSingleFile('plain.bin');

    expect(upload).toHaveBeenCalled();
    expect(notices().length).toBe(0);
  });
});
