// [SPEC:SG-1..SG-4][SPEC:WB-1..WB-2] specs/main/spec.md §9 — download safety guards (spec 025).
// (1) Server-anomaly guard: never overwrite local with a body whose length disagrees with the size
//     the server advertised (0-byte / truncated). (2) Write-back verification: atomicWriteBinary
//     confirms the file landed at the intended byte length (fsync is unavailable).
import { DataAdapter } from 'obsidian';
import { isAnomalousRemoteContent } from '../../../src/util/limits';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';

const buf = (n: number): ArrayBuffer => new Uint8Array(n).buffer;

describe('[SPEC:SG-1..SG-4] isAnomalousRemoteContent (server-anomaly size guard)', () => {
  it('SG-1 advertised >0 but received 0 (server returned empty body) → anomalous', () => {
    expect(isAnomalousRemoteContent(10, 0)).toBe(true);
  });
  it('SG-1 advertised >0 but received a different (truncated) length → anomalous', () => {
    expect(isAnomalousRemoteContent(100, 40)).toBe(true);
  });
  it('SG-3 legitimately empty (advertised 0, received 0) → NOT anomalous (no false positive)', () => {
    expect(isAnomalousRemoteContent(0, 0)).toBe(false);
  });
  it('SG-3 advertised == received → NOT anomalous', () => {
    expect(isAnomalousRemoteContent(123, 123)).toBe(false);
  });
});

// ── Engine guard wiring (download path) ───────────────────────────────────────────────────────
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
const PLUGIN_DIR = '.obsidian/plugins/obsidian-nextcloudsync';

function makeSummary(): SyncSessionSummary {
  return { startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [] };
}

describe('[SPEC:SG-2][SPEC:SG-4] SyncEngine.downloadFile refuses an anomalous remote body', () => {
  it('keeps local, does not write, does not advance Base, flags conflicted, queues retry', async () => {
    const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev-1');
    await stateDB.load();
    const base: FileState = { path: 'x.md', localHash: 'h', remoteId: 'e-old', idType: 'etag', size: 10, mtime: 1, remoteFileId: 'f', isConflicted: false };
    stateDB.setFile(base);

    const atomicWriteBinary = jest.fn();
    const engine = new SyncEngine({
      app: {}, settings: { ...DEFAULT_SETTINGS }, localAdapter: { atomicWriteBinary },
      stateDB, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: '.obsidian',
    } as never);
    const client = { downloadFile: jest.fn(async () => buf(0)) }; // server returns 0 bytes…
    (engine as unknown as { client: unknown }).client = client;

    const remote: RemoteFileInfo = { path: 'x.md', fileId: 'f', checksum: null, etag: 'e-new', size: 10, lastModified: 0 }; // …but advertises 10
    const summary = makeSummary();
    await (engine as unknown as { downloadFile: (r: RemoteFileInfo, id: string, t: string, s: SyncSessionSummary) => Promise<void> })
      .downloadFile(remote, 'e-new', 'etag', summary);

    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(atomicWriteBinary).not.toHaveBeenCalled();          // local NOT overwritten
    expect(summary.downloadedCount).toBe(0);
    expect(summary.errorCount).toBe(1);
    expect((engine as unknown as { retryQueue: string[] }).retryQueue).toContain('x.md');
    expect(stateDB.getFile('x.md')?.remoteId).toBe('e-old');   // Base NOT advanced
    expect(stateDB.getFile('x.md')?.isConflicted).toBe(true);  // surfaced as conflicted
  });
});

// ── LocalAdapter.atomicWriteBinary read-back verification ─────────────────────────────────────
function fakeFsAdapter(statOverride?: () => Promise<{ size: number; mtime: number } | null>): DataAdapter {
  const sizes = new Map<string, number>();
  return {
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { sizes.set(p, d.byteLength); }),
    exists: jest.fn(async (p: string) => sizes.has(p)),
    remove: jest.fn(async (p: string) => { sizes.delete(p); }),
    rename: jest.fn(async (f: string, t: string) => { sizes.set(t, sizes.get(f)!); sizes.delete(f); }),
    stat: jest.fn(statOverride ?? (async (p: string) => (sizes.has(p) ? { size: sizes.get(p)!, mtime: 0 } : null))),
    mkdir: jest.fn(), read: jest.fn(), write: jest.fn(), readBinary: jest.fn(), list: jest.fn(),
  } as unknown as DataAdapter;
}

describe('[SPEC:WB-1][SPEC:WB-2] LocalAdapter.atomicWriteBinary read-back verification', () => {
  it('WB-1 succeeds when the written size matches the intended byte length', async () => {
    const la = new LocalAdapter(fakeFsAdapter());
    await expect(la.atomicWriteBinary('note.md', buf(5))).resolves.toBeUndefined();
  });
  it('WB-2 throws when the read-back size mismatches (truncated/corrupt write)', async () => {
    const la = new LocalAdapter(fakeFsAdapter(async () => ({ size: 3, mtime: 0 }))); // server/FS lied: 3 ≠ 5
    await expect(la.atomicWriteBinary('note.md', buf(5))).rejects.toThrow(/write-back verification failed/);
  });
  it('WB-2 throws when the file is missing after write', async () => {
    const la = new LocalAdapter(fakeFsAdapter(async () => null));
    await expect(la.atomicWriteBinary('note.md', buf(5))).rejects.toThrow(/write-back verification failed/);
  });
});
