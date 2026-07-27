// [SPEC:UBC-1..UBC-8] specs/063-fix-untracked-overwrite/contracts/sync-classification.md
//
// Rows 8/9 of the classification contract: a file that exists on BOTH sides but has NO StateDB
// record (base === undefined). The incremental path used to skip local-change detection entirely
// whenever base was missing, so it fell through to "remote changed only" and downloaded over the
// local content — silent data loss (GitHub issue #23).
//
// These tests drive the REAL SyncEngine.processRemoteFile. They deliberately do NOT reimplement the
// classification logic: the bug survived for so long precisely because syncEngine.test.ts asserted
// against a local copy of `classify()` that the engine never calls.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';

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

function makeSummary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
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
  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS, ...settings },
    localAdapter, stateDB, baseStore, statusBar: {}, webdavFactory: {},
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);
  (engine as unknown as { client: unknown }).client = client;
  (engine as unknown as { uploadStrategy: unknown }).uploadStrategy = uploadStrategy;
  return { engine, stateDB, baseStore };
}

const callProcessRemote = (e: SyncEngine, r: RemoteFileInfo, s: SyncSessionSummary) =>
  (e as unknown as {
    processRemoteFile: (r: RemoteFileInfo, s: SyncSessionSummary) => Promise<void>;
  }).processRemoteFile(r, s);

const remoteOf = (path: string, body: string, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo =>
  ({
    path, fileId: 'f1', checksum: null, etag: 'remote-etag',
    size: enc.encode(body).length, lastModified: 9_000, ...over,
  });

/** Seed an unrelated tracked file so the StateDB is non-empty (the engine is past its first sync). */
function seedUnrelated(stateDB: StateDB): void {
  const other: FileState = {
    path: 'unrelated.md', localHash: 'h', remoteId: 'h', idType: 'sha256',
    size: 1, mtime: 1, remoteFileId: null, isConflicted: false,
  };
  stateDB.setFile(other);
}

describe('[SPEC:UBC-1] untracked file present on both sides — local content is never silently replaced', () => {
  it('[SPEC:UBC-1] keeps the local body when a .md exists on both sides with no StateDB record', async () => {
    const LOCAL = 'shared intro\n\nwritten on this device\n';
    const REMOTE = 'shared intro\n\nwritten on the other device\n';
    const local = makeLocalAdapter({ 'note.md': LOCAL });
    const client = { downloadFile: jest.fn(async () => toBuf(REMOTE)) };
    const { engine, stateDB } = await buildEngine(local, client);
    seedUnrelated(stateDB);
    expect(stateDB.getFile('note.md')).toBeUndefined();

    const summary = makeSummary();
    await callProcessRemote(engine, remoteOf('note.md', REMOTE), summary);

    // The local-only sentence must survive: a plain download would have wiped it.
    expect(local.files['note.md']).toContain('written on this device');
  });
});

describe('[SPEC:UBC-2] untracked .md on both sides is merged, not overwritten', () => {
  it('[SPEC:UBC-2] the resolved body contains BOTH sides of the edit', async () => {
    const LOCAL = 'shared intro\n\nwritten on this device\n';
    const REMOTE = 'shared intro\n\nwritten on the other device\n';
    const local = makeLocalAdapter({ 'note.md': LOCAL });
    const client = { downloadFile: jest.fn(async () => toBuf(REMOTE)) };
    const { engine, stateDB } = await buildEngine(local, client);
    seedUnrelated(stateDB);

    await callProcessRemote(engine, remoteOf('note.md', REMOTE), makeSummary());

    expect(local.files['note.md']).toContain('written on this device');
    expect(local.files['note.md']).toContain('written on the other device');
  });
});

describe('[SPEC:UBC-5] untracked non-mergeable file follows the configured strategy', () => {
  it('[SPEC:UBC-5] latest-mtime picks the remote side when remote is newer (no base-missing special case)', async () => {
    const LOCAL = 'local-binary-ish';
    const REMOTE = 'remote-binary-ish';
    // local mtime 1000 < remote lastModified 9000 => latest-mtime must choose remote.
    const local = makeLocalAdapter({ 'asset.bin': LOCAL }, { 'asset.bin': 1_000 });
    const client = { downloadFile: jest.fn(async () => toBuf(REMOTE)) };
    const { engine, stateDB } = await buildEngine(local, client, { otherFileStrategy: 'latest-mtime' });
    seedUnrelated(stateDB);

    await callProcessRemote(engine, remoteOf('asset.bin', REMOTE), makeSummary());

    // The point is that a decision was MADE by the configured strategy (remote is newer),
    // not that the file was blindly downloaded without classification.
    expect(local.files['asset.bin']).toBe(REMOTE);
    expect(client.downloadFile).toHaveBeenCalled();
  });

  it('[SPEC:UBC-5] latest-mtime keeps the local side when local is newer', async () => {
    const LOCAL = 'local-newer';
    const REMOTE = 'remote-older';
    const local = makeLocalAdapter({ 'asset.bin': LOCAL }, { 'asset.bin': 20_000 });
    const client = { downloadFile: jest.fn(async () => toBuf(REMOTE)) };
    const upload = jest.fn(async () => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, { otherFileStrategy: 'latest-mtime' }, { upload });
    seedUnrelated(stateDB);

    await callProcessRemote(engine, remoteOf('asset.bin', REMOTE, { lastModified: 5_000 }), makeSummary());

    expect(local.files['asset.bin']).toBe(LOCAL); // local edit preserved
    expect(upload).toHaveBeenCalled();            // and pushed so both sides converge
  });
});

describe('[SPEC:UBC-3] untracked file whose content already matches the remote', () => {
  it('[SPEC:UBC-3] seeds the state without transferring when the server checksum proves both sides match', async () => {
    const BODY = 'already identical on both sides\n';
    const checksum = await sha256(toBuf(BODY));
    const local = makeLocalAdapter({ 'same.md': BODY });
    const client = { downloadFile: jest.fn(async () => toBuf(BODY)) };
    const upload = jest.fn(async () => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    seedUnrelated(stateDB);

    const summary = makeSummary();
    await callProcessRemote(engine, remoteOf('same.md', BODY, { checksum }), summary);

    // No transfer in either direction — the bodies are provably equal.
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(summary.downloadedCount).toBe(0);
    expect(summary.uploadedCount).toBe(0);

    // The baseline is now recorded, so the file reads as converged from here on.
    const seeded = stateDB.getFile('same.md');
    expect(seeded).toBeDefined();
    expect(seeded!.remoteId).toBe(checksum);
    expect(seeded!.localHash).toBe(checksum);
    expect(seeded!.isConflicted).toBe(false);
  });

  it('[SPEC:UBC-3] a second sync of the same file is classified as unchanged (no transfer, no conflict)', async () => {
    const BODY = 'already identical on both sides\n';
    const checksum = await sha256(toBuf(BODY));
    const local = makeLocalAdapter({ 'same.md': BODY });
    const client = { downloadFile: jest.fn(async () => toBuf(BODY)) };
    const upload = jest.fn(async () => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    seedUnrelated(stateDB);

    await callProcessRemote(engine, remoteOf('same.md', BODY, { checksum }), makeSummary());
    const second = makeSummary();
    await callProcessRemote(engine, remoteOf('same.md', BODY, { checksum }), second);

    expect(second.downloadedCount + second.uploadedCount).toBe(0);
    expect(second.mergedCount + second.conflictedCount).toBe(0);
    expect(local.files['same.md']).toBe(BODY);
  });
});

describe('[SPEC:UBC-4] a remote-only file is still a plain download', () => {
  it('[SPEC:UBC-4] downloads when there is no StateDB record AND no local file (regression guard)', async () => {
    const REMOTE = 'brand new note from the server\n';
    const local = makeLocalAdapter({}); // nothing locally
    const client = { downloadFile: jest.fn(async () => toBuf(REMOTE)) };
    const upload = jest.fn(async () => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    seedUnrelated(stateDB);

    const summary = makeSummary();
    await callProcessRemote(engine, remoteOf('fresh.md', REMOTE), summary);

    expect(local.files['fresh.md']).toBe(REMOTE);
    expect(summary.downloadedCount).toBe(1);
    expect(summary.mergedCount + summary.conflictedCount).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('[SPEC:UBC-8] tracked files keep their existing classification', () => {
  it('[SPEC:UBC-8] remote-only change on a tracked file still downloads', async () => {
    const OLD = 'v1\n';
    const NEW = 'v2 from the other device\n';
    const oldHash = await sha256(toBuf(OLD));
    const newChecksum = await sha256(toBuf(NEW));
    const local = makeLocalAdapter({ 'tracked.md': OLD });
    const client = { downloadFile: jest.fn(async () => toBuf(NEW)) };
    const { engine, stateDB } = await buildEngine(local, client);
    stateDB.setFile({
      path: 'tracked.md', localHash: oldHash, remoteId: oldHash, idType: 'sha256',
      size: enc.encode(OLD).length, mtime: 1_000, remoteFileId: 'f1', isConflicted: false,
    });

    const summary = makeSummary();
    await callProcessRemote(engine, remoteOf('tracked.md', NEW, { checksum: newChecksum }), summary);

    expect(local.files['tracked.md']).toBe(NEW);
    expect(summary.downloadedCount).toBe(1);
  });

  it('[SPEC:UBC-8] local-only change on a tracked file still uploads', async () => {
    const SYNCED = 'v1\n';
    const EDITED = 'v1 plus a local edit\n';
    const syncedHash = await sha256(toBuf(SYNCED));
    const local = makeLocalAdapter({ 'tracked.md': EDITED });
    const client = { downloadFile: jest.fn(async () => toBuf(SYNCED)) };
    const upload = jest.fn(async () => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    stateDB.setFile({
      path: 'tracked.md', localHash: syncedHash, remoteId: syncedHash, idType: 'sha256',
      size: enc.encode(SYNCED).length, mtime: 1_000, remoteFileId: 'f1', isConflicted: false,
    });

    const summary = makeSummary();
    await callProcessRemote(engine, remoteOf('tracked.md', SYNCED, { checksum: syncedHash }), summary);

    expect(local.files['tracked.md']).toBe(EDITED); // local edit is the winner, pushed up
    expect(upload).toHaveBeenCalled();
    expect(summary.downloadedCount).toBe(0);
  });

  it('[SPEC:UBC-8] a converged tracked file is a no-op', async () => {
    const BODY = 'nothing changed here\n';
    const hash = await sha256(toBuf(BODY));
    const local = makeLocalAdapter({ 'tracked.md': BODY });
    const client = { downloadFile: jest.fn(async () => toBuf(BODY)) };
    const upload = jest.fn(async () => 'uploaded' as const);
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    stateDB.setFile({
      path: 'tracked.md', localHash: hash, remoteId: hash, idType: 'sha256',
      size: enc.encode(BODY).length, mtime: 1_000, remoteFileId: 'f1', isConflicted: false,
    });

    const summary = makeSummary();
    await callProcessRemote(engine, remoteOf('tracked.md', BODY, { checksum: hash }), summary);

    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(summary.downloadedCount + summary.uploadedCount).toBe(0);
  });

  it('[SPEC:UBC-8] a tracked file deleted locally still propagates the deletion', async () => {
    const BODY = 'to be deleted\n';
    const hash = await sha256(toBuf(BODY));
    const local = makeLocalAdapter({}); // gone locally
    const deleteFile = jest.fn(async (_path: string, _ifMatch?: string) => undefined);
    const client = { downloadFile: jest.fn(async () => toBuf(BODY)), deleteFile };
    const { engine, stateDB } = await buildEngine(local, client);
    stateDB.setFile({
      path: 'gone.md', localHash: hash, remoteId: hash, idType: 'sha256',
      size: enc.encode(BODY).length, mtime: 1_000, remoteFileId: 'f1', isConflicted: false,
    });

    const summary = makeSummary();
    await callProcessRemote(engine, remoteOf('gone.md', BODY, { checksum: hash }), summary);

    // Called with the path (plus the If-Match id the engine passes for lost-update safety).
    expect(deleteFile.mock.calls[0][0]).toBe('gone.md');
    expect(local.files['gone.md']).toBeUndefined(); // not resurrected
  });
});

describe('[SPEC:UBC-7] a failed transfer during resolution still converges on the next sync', () => {
  it('[SPEC:UBC-7] keeps the local body and stays conflicted when the merge upload fails, then converges', async () => {
    const LOCAL = 'shared intro\n\nwritten on this device\n';
    // Faithful remote side: downloadFile serves whatever the server currently holds, and a
    // successful upload replaces it. Without this the second sync would be fed stale bytes and the
    // test would measure the double, not the engine.
    const remoteState = { body: 'shared intro\n\nwritten on the other device\n' };
    const local = makeLocalAdapter({ 'note.md': LOCAL });
    const client = { downloadFile: jest.fn(async () => toBuf(remoteState.body)) };
    // First attempt: the push of the merged body fails (network drop mid-resolution).
    let failNext = true;
    const upload = jest.fn(async (_c: unknown, _p: string, data: ArrayBuffer) => {
      if (failNext) throw new Error('simulated upload failure');
      remoteState.body = dec.decode(data);
      return 'uploaded' as const;
    });
    const { engine, stateDB } = await buildEngine(local, client, {}, { upload });
    seedUnrelated(stateDB);

    const remoteNow = (): RemoteFileInfo =>
      remoteOf('note.md', remoteState.body, { etag: `etag-${enc.encode(remoteState.body).length}` });

    await callProcessRemote(engine, remoteNow(), makeSummary());

    // Both edits are preserved locally even though the push failed...
    expect(local.files['note.md']).toContain('written on this device');
    expect(local.files['note.md']).toContain('written on the other device');
    // ...and the divergence is still flagged so the next sync retries instead of declaring success.
    expect(stateDB.getFile('note.md')?.isConflicted).toBe(true);

    // Next sync: the push succeeds and both sides converge (self-healing).
    failNext = false;
    await callProcessRemote(engine, remoteNow(), makeSummary());

    expect(local.files['note.md']).toContain('written on this device');
    expect(remoteState.body).toContain('written on this device'); // the merge reached the server
    expect(stateDB.getFile('note.md')?.isConflicted).toBe(false);
  });
});

describe('[SPEC:UBC-6] the outcome is surfaced in the session summary', () => {
  it('[SPEC:UBC-6] counts an untracked both-sides .md as merged or conflicted, not as a plain download', async () => {
    const local = makeLocalAdapter({ 'note.md': 'shared\n\nlocal line\n' });
    const client = { downloadFile: jest.fn(async () => toBuf('shared\n\nremote line\n')) };
    const { engine, stateDB } = await buildEngine(local, client);
    seedUnrelated(stateDB);

    const summary = makeSummary();
    await callProcessRemote(engine, remoteOf('note.md', 'shared\n\nremote line\n'), summary);

    expect(summary.mergedCount + summary.conflictedCount).toBeGreaterThan(0);
    expect(summary.downloadedCount).toBe(0);
  });
});
