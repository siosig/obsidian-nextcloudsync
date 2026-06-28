// [SPEC:DSG-1..DSG-8] specs/main/spec.md — download-side "Maximum file size" guard (spec 035).
// The maxFileSizeMB cap is applied symmetrically on DOWNLOAD: before any GET, a remote whose
// PROPFIND-advertised size exceeds the cap is skipped (no body fetched) across every remote-body
// path — normal download, delete-vs-edit restore, conflict, compare, manual pull. This prevents the
// Android OOM (issue #8) where requestUrl base64-encodes the whole body in memory.
import { DataAdapter, Notice } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';

const MB = 1024 * 1024;
const buf = (n: number): ArrayBuffer => new Uint8Array(n).buffer;
const PLUGIN_DIR = '.obsidian/plugins/obsidian-nextcloudsync';

function makeStateAdapter(files: Record<string, string> = {}): DataAdapter {
  const store = { ...files };
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    readBinary: jest.fn(), writeBinary: jest.fn(),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (f: string, t: string) => { store[t] = store[f]; delete store[f]; }),
    stat: jest.fn(), list: jest.fn(),
  } as unknown as DataAdapter;
}

function makeSummary(): SyncSessionSummary {
  return { startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [] };
}

const remoteOf = (path: string, size: number, over: Partial<RemoteFileInfo> = {}): RemoteFileInfo =>
  ({ path, fileId: 'f', checksum: null, etag: 'e-new', size, lastModified: 0, ...over });

/** The mock Notice records every constructed toast on a static `instances` array (test double only). */
const notices = (): { message: string }[] =>
  (Notice as unknown as { instances: { message: string }[] }).instances;

/** Build an engine with a real StateDB and a configurable local adapter + client. */
async function buildEngine(maxFileSizeMB: number, localAdapter: Record<string, unknown> = {}) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev-1');
  await stateDB.load();
  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS, maxFileSizeMB }, localAdapter,
    stateDB, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);
  return { engine, stateDB };
}

const callDownload = (engine: SyncEngine, remote: RemoteFileInfo, summary: SyncSessionSummary) =>
  (engine as unknown as { downloadFile: (r: RemoteFileInfo, id: string, t: string, s: SyncSessionSummary) => Promise<void> })
    .downloadFile(remote, 'e-new', 'etag', summary);

beforeEach(() => { notices().length = 0; });

describe('[SPEC:DSG-1] sync download skips an oversized remote before the GET', () => {
  it('does not fetch, does not write, does not advance Base, no retry, no error', async () => {
    const atomicWriteBinary = jest.fn();
    const { engine, stateDB } = await buildEngine(20, { atomicWriteBinary, setMtime: jest.fn(), stat: jest.fn() });
    const base: FileState = { path: 'big.bin', localHash: 'h', remoteId: 'e-old', idType: 'etag', size: 1, mtime: 1, remoteFileId: 'f', isConflicted: false };
    stateDB.setFile(base);
    const client = { downloadFile: jest.fn(async () => buf(0)) };
    (engine as unknown as { client: unknown }).client = client;

    const summary = makeSummary();
    await callDownload(engine, remoteOf('big.bin', 30 * MB), summary);

    expect(client.downloadFile).not.toHaveBeenCalled();          // body NEVER fetched (SC-002)
    expect(atomicWriteBinary).not.toHaveBeenCalled();            // local untouched
    expect(summary.downloadedCount).toBe(0);
    expect(summary.errorCount).toBe(0);                          // permanent skip, not an error
    expect((engine as unknown as { retryQueue: string[] }).retryQueue).not.toContain('big.bin');
    expect(stateDB.getFile('big.bin')?.remoteId).toBe('e-old');  // Base NOT advanced
    expect(stateDB.getFile('big.bin')?.isConflicted).toBe(false);
    expect(notices().at(-1)?.message).toMatch(/too large to download/i);
  });
});

describe('[SPEC:DSG-2] delete-vs-edit restore routes through the same guard', () => {
  it('does not fetch the oversized remote when restoring a remotely-edited deleted file', async () => {
    const { engine, stateDB } = await buildEngine(20, { atomicWriteBinary: jest.fn(), setMtime: jest.fn(), stat: jest.fn() });
    // serverHash (remote.checksum) differs from base.localHash → restore branch → downloadFile().
    const base: FileState = { path: 'big.bin', localHash: 'orig', remoteId: 'r', idType: 'sha256', size: 1, mtime: 1, remoteFileId: 'f', isConflicted: false };
    stateDB.setFile(base);
    const client = { downloadFile: jest.fn(async () => buf(0)), deleteFile: jest.fn() };
    (engine as unknown as { client: unknown }).client = client;

    const remote = remoteOf('big.bin', 30 * MB, { checksum: 'different' });
    const summary = makeSummary();
    await (engine as unknown as {
      applyLocalDeletion: (r: RemoteFileInfo, b: FileState, id: string, t: string, s: SyncSessionSummary) => Promise<void>;
    }).applyLocalDeletion(remote, base, 'r', 'sha256', summary);

    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
  });
});

describe('[SPEC:DSG-3] conflict (both changed) with oversized remote (FR-010)', () => {
  it('skips the merge download, keeps local, flags conflicted, no retry, no error', async () => {
    const { engine, stateDB } = await buildEngine(20, { stat: jest.fn(), read: jest.fn(), readBinary: jest.fn() });
    const base: FileState = { path: 'big.bin', localHash: 'lh', remoteId: 'rh', idType: 'sha256', size: 1, mtime: 1, remoteFileId: 'f', isConflicted: false };
    stateDB.setFile(base);
    const client = { downloadFile: jest.fn() };
    (engine as unknown as { client: unknown }).client = client;

    const summary = makeSummary();
    await (engine as unknown as {
      handleConflict: (p: string, b: FileState | undefined, r: RemoteFileInfo, id: string, t: string, s: SyncSessionSummary) => Promise<void>;
    }).handleConflict('big.bin', base, remoteOf('big.bin', 30 * MB), 'rh', 'sha256', summary);

    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(stateDB.getFile('big.bin')?.isConflicted).toBe(true);   // surfaced for the user
    expect(stateDB.getFile('big.bin')?.remoteId).toBe('rh');       // Base NOT advanced
    expect(summary.errorCount).toBe(0);
    expect((engine as unknown as { retryQueue: string[] }).retryQueue).not.toContain('big.bin');
    expect(notices().at(-1)?.message).toMatch(/too large to download/i);
  });
});

describe('[SPEC:DSG-4] compare/diff preview with oversized remote (FR-011)', () => {
  it('does not fetch the body; shows metadata only (no line diff)', async () => {
    const { engine } = await buildEngine(20, { stat: jest.fn(async () => null), readBinary: jest.fn() });
    const client = { getFiles: jest.fn(async () => [remoteOf('big.bin', 30 * MB)]), downloadFile: jest.fn() };
    (engine as unknown as { client: unknown }).client = client;
    (engine as unknown as { features: unknown }).features = { isNextcloud: true };

    const result = await engine.compareWithRemote('big.bin');

    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(result.state).toBe('ok');
    expect(result.remoteExists).toBe(true);
    expect(result.remoteText).toBeNull();
    expect(result.diffAvailable).toBe(false);
    expect(result.remoteSize).toBe(30 * MB);     // server-advertised size preserved
    expect(notices().at(-1)?.message).toMatch(/too large to preview/i);
  });
});

describe('[SPEC:DSG-5] manual pull with oversized remote (FR-011)', () => {
  it('throws a clear error and never fetches the body', async () => {
    const { engine } = await buildEngine(20, { stat: jest.fn(async () => null) });
    const client = { getFiles: jest.fn(async () => [remoteOf('big.bin', 30 * MB)]), downloadFile: jest.fn() };
    (engine as unknown as { client: unknown }).client = client;
    (engine as unknown as { features: unknown }).features = { isNextcloud: true };

    await expect(engine.pullRemoteToLocal('big.bin')).rejects.toThrow(/too large to download/i);
    expect(client.downloadFile).not.toHaveBeenCalled();
  });
});

describe('[SPEC:DSG-6] maxFileSizeMB = 0 is unlimited (desktop default, FR-008)', () => {
  it('downloads regardless of size', async () => {
    const atomicWriteBinary = jest.fn(async () => undefined);
    const { engine } = await buildEngine(0, {
      atomicWriteBinary, setMtime: jest.fn(async () => undefined),
      stat: jest.fn(async () => ({ size: 10, mtime: 0 })),
    });
    const client = { downloadFile: jest.fn(async () => buf(10)) };
    (engine as unknown as { client: unknown }).client = client;

    const summary = makeSummary();
    await callDownload(engine, remoteOf('huge.bin', 100 * MB), summary);

    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(atomicWriteBinary).toHaveBeenCalledTimes(1);
    expect(summary.downloadedCount).toBe(1);
  });
});

describe('[SPEC:DSG-7] size exactly at the cap is allowed (boundary)', () => {
  it('downloads when remote.size === cap (not over)', async () => {
    const atomicWriteBinary = jest.fn(async () => undefined);
    const { engine } = await buildEngine(20, {
      atomicWriteBinary, setMtime: jest.fn(async () => undefined),
      stat: jest.fn(async () => ({ size: 10, mtime: 0 })),
    });
    const client = { downloadFile: jest.fn(async () => buf(10)) };
    (engine as unknown as { client: unknown }).client = client;

    const summary = makeSummary();
    await callDownload(engine, remoteOf('exact.bin', 20 * MB), summary);

    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(summary.downloadedCount).toBe(1);
  });
});

describe('[SPEC:DSG-8] self-healing: raising the cap downloads the once-skipped file (FR-006/SC-005)', () => {
  it('skips while over the cap, then downloads after the cap is raised', async () => {
    const atomicWriteBinary = jest.fn(async () => undefined);
    const settings = { ...DEFAULT_SETTINGS, maxFileSizeMB: 20 };
    const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev-1');
    await stateDB.load();
    const engine = new SyncEngine({
      app: {}, settings, localAdapter: { atomicWriteBinary, setMtime: jest.fn(async () => undefined), stat: jest.fn(async () => ({ size: 10, mtime: 0 })) },
      stateDB, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: '.obsidian',
    } as never);
    const client = { downloadFile: jest.fn(async () => buf(10)) };
    (engine as unknown as { client: unknown }).client = client;

    const remote = remoteOf('healme.bin', 30 * MB);

    // 1) Over the cap → skipped, body never fetched.
    await callDownload(engine, remote, makeSummary());
    expect(client.downloadFile).not.toHaveBeenCalled();

    // 2) Raise the cap (the setting is read live each call) → next reconcile downloads it.
    settings.maxFileSizeMB = 100;
    const summary2 = makeSummary();
    await callDownload(engine, remote, summary2);
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(summary2.downloadedCount).toBe(1);
  });
});
