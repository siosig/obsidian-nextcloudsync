import { massDeleteLimit, isMassDeletionGuarded, MASS_DELETE_MIN, effectiveMassDeleteLimit } from '../../../src/util/limits';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { sha256 } from '../../../src/util/hash';
import { DavSyncSettings, FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';

// Feature 049: the mass-delete breaker limit is user-configurable (Advanced / caution). -1 = automatic
// (safe default), 0 = unlimited (opt-in), N = fixed absolute.
describe('[SPEC:DEL-3] effectiveMassDeleteLimit — user-configurable breaker (feature 049)', () => {
  it('-1 (default) uses the automatic dynamic limit', () => {
    expect(effectiveMassDeleteLimit(-1, 0)).toBe(MASS_DELETE_MIN);
    expect(effectiveMassDeleteLimit(-1, 1000)).toBe(massDeleteLimit(1000)); // 200
  });
  it('0 means unlimited (breaker never fires)', () => {
    expect(effectiveMassDeleteLimit(0, 1000)).toBe(Number.POSITIVE_INFINITY);
    expect(1_000_000 > effectiveMassDeleteLimit(0, 10)).toBe(false); // nothing exceeds Infinity
  });
  it('a positive value is a fixed absolute limit (overrides the dynamic one)', () => {
    expect(effectiveMassDeleteLimit(50, 1000)).toBe(50); // fixed 50 even though auto would be 200
    expect(effectiveMassDeleteLimit(500, 100)).toBe(500); // raise above the auto 20
  });
});

// [SPEC:DEL-3] specs/main/spec.md §8 — mass-delete circuit breaker. A full-scan reconciliation may delete
// locally at most max(20, floor(20% of tracked)) "remotely absent" files; beyond that it assumes a
// partial/failed remote listing and refuses, to avoid wiping the vault. The threshold previously
// lived as an inline `Math.max(20, Math.floor(tracked * 0.2))` in SyncEngine with no a-layer test
// (its only b-1 test is an it.skip stub); extracted here as a pure helper so the contract is verified.

describe('[SPEC:DEL-3] mass-delete circuit breaker threshold', () => {
  describe('massDeleteLimit', () => {
    it('floors at 20 for small/empty tracked sets (20% would be lower)', () => {
      expect(massDeleteLimit(0)).toBe(MASS_DELETE_MIN);
      expect(massDeleteLimit(1)).toBe(20);
      expect(massDeleteLimit(99)).toBe(20); // floor(19.8)=19 < 20 → clamped to 20
      expect(massDeleteLimit(100)).toBe(20); // floor(20)=20, tie → 20
    });

    it('scales to 20% of the tracked set once that exceeds 20', () => {
      expect(massDeleteLimit(101)).toBe(20); // floor(20.2)=20
      expect(massDeleteLimit(105)).toBe(21); // floor(21)=21 > 20
      expect(massDeleteLimit(1000)).toBe(200);
    });
  });

  describe('isMassDeletionGuarded', () => {
    it('does NOT guard when candidates are within the limit', () => {
      expect(isMassDeletionGuarded(20, 50)).toBe(false); // limit 20, 20 is not > 20
      expect(isMassDeletionGuarded(200, 1000)).toBe(false); // limit 200, exactly at cap
      expect(isMassDeletionGuarded(0, 0)).toBe(false);
    });

    it('guards (refuses bulk local deletion) when candidates exceed the limit', () => {
      expect(isMassDeletionGuarded(21, 50)).toBe(true); // limit 20
      expect(isMassDeletionGuarded(201, 1000)).toBe(true); // limit 200
      // A near-total wipe of a large vault is always guarded.
      expect(isMassDeletionGuarded(900, 1000)).toBe(true);
    });
  });
});

// Feature 055 (specs/055-massdelete-skip-visibility): when the FILE-side (absence-deletion) breaker
// above trips, the skipped candidate paths are recorded as diagnostic info on the SyncErrorDetail
// (`skippedPaths.sample` truncated to 10 + `skippedPaths.totalCount`), so the sync-status dialog can
// show the user WHICH files were skipped, not just that "some files" were. This drives SyncEngine's
// private `processLocalModifications` full-scan absence-deletion path directly, mirroring the
// `[SPEC:MDV-1]` dir-breaker harness in tests/a-no-nextcloud/sync/dirSync.test.ts.
describe('[SPEC:MDV-2] SyncEngine file mass-delete breaker — skippedPaths diagnostic (feature 055)', () => {
  const CONFIG_DIR = '.obsidian';
  const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;

  function makeSummary(): SyncSessionSummary {
    return {
      startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0,
      deletedCount: 0, mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
    };
  }

  function settings(): DavSyncSettings {
    return {
      configDir: CONFIG_DIR, syncConfigFolder: false, excludedFolders: [], networkConcurrency: 4,
      massDeleteLimit: -1, // feature 049 default: automatic dynamic limit (max(20, 20% of tracked))
      configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
    } as unknown as DavSyncSettings;
  }

  const fstate = (path: string, hash: string): FileState => ({
    path, localHash: hash, remoteId: hash, idType: 'sha256', size: 1, mtime: 0,
    remoteFileId: null, isConflicted: false,
  });

  function makeEngine(tracked: FileState[], unchangedData: ArrayBuffer) {
    const store = new Map<string, FileState>(tracked.map((f) => [f.path, f]));
    const adapter = {
      listVaultFiles: () => tracked.map((f) => ({ path: f.path, size: 1, mtime: 0 })),
      list: jest.fn(async () => ({ files: [], folders: [] })),
      stat: jest.fn(async () => null),
      readBinary: jest.fn(async () => unchangedData),
    };
    const app = { vault: { adapter, getFiles: () => [] }, fileManager: {} };
    const stateDB = {
      getFile: (p: string) => store.get(p),
      getAllFiles: () => [...store.values()],
      deleteFile: jest.fn(),
      getLastSyncTime: () => 0,
    };
    const engine = new SyncEngine({
      app, settings: settings(), localAdapter: adapter,
      stateDB, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: CONFIG_DIR,
    } as never);
    return { engine, store };
  }

  // Drives the private full-scan absence-deletion path directly (same style as dirSync.test.ts's
  // `reconcile` helper for `reconcileDirectories`).
  const runFullScan = (
    engine: SyncEngine, remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary,
  ): Promise<void> =>
    (engine as unknown as {
      processLocalModifications(
        remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary, isFullScan?: boolean,
      ): Promise<void>;
    }).processLocalModifications(remoteFiles, summary, true);

  it('[SPEC:MDV-2] file mass-delete breaker records skippedPaths with sample and totalCount', async () => {
    const unchangedData = new TextEncoder().encode('unchanged-content').buffer;
    const hash = await sha256(unchangedData);
    // 25 tracked files, all present locally with content matching the stored hash (so they are NOT
    // filtered out as "locally modified"), but absent from the (complete) remote listing → all 25
    // become absence-deletion candidates. effectiveMassDeleteLimit(-1, 25) = massDeleteLimit(25) =
    // max(20, floor(25*0.2)) = 20, so 25 > 20 trips the breaker (same scale as dirSync's MDV-1 case).
    const tracked = Array.from({ length: 25 }, (_, i) => fstate(`note${i}.md`, hash));
    const { engine } = makeEngine(tracked, unchangedData);
    const summary = makeSummary();
    // The full-scan absence-deletion path only runs when remotePathSet.size > 0; a single unrelated
    // remote file satisfies that without matching (and thus without excluding) any tracked candidate.
    const remoteFiles: RemoteFileInfo[] = [
      { path: 'unrelated.md', fileId: null, checksum: hash, etag: null, size: 1, lastModified: 0 },
    ];

    await runFullScan(engine, remoteFiles, summary);

    const breakerError = summary.errors.find((e) => e.path === '(mass-delete breaker)');
    expect(breakerError).toBeDefined();
    expect(breakerError!.skippedPaths).toBeDefined();
    expect(breakerError!.skippedPaths!.totalCount).toBe(tracked.length); // 25 skipped candidates total
    expect(breakerError!.skippedPaths!.sample.length).toBeLessThanOrEqual(10);
    const expectedCandidates = tracked.map((f) => f.path);
    for (const p of breakerError!.skippedPaths!.sample) {
      expect(expectedCandidates).toContain(p);
    }
  });

  // Drives the private `recordError` directly (same private-method-cast pattern as `runFullScan`
  // above) to prove that ordinary, non-breaker error recording is unaffected by the skippedPaths
  // diagnostic added for the mass-delete breaker: a plain per-file error (e.g. an upload/download
  // failure) must NOT get a skippedPaths value — only the breaker call sites (feature 055) pass one.
  const callRecordError = (engine: SyncEngine, summary: SyncSessionSummary, path: string, err: unknown): void =>
    (engine as unknown as {
      recordError(summary: SyncSessionSummary, path: string, err: unknown): void;
    }).recordError(summary, path, err);

  it('[SPEC:MDV-4] ordinary (non-breaker) errors leave skippedPaths undefined', () => {
    const unchangedData = new TextEncoder().encode('unchanged-content').buffer;
    const { engine } = makeEngine([], unchangedData);
    const summary = makeSummary();

    callRecordError(engine, summary, 'note0.md', new Error('upload failed: 500 Internal Server Error'));

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].path).toBe('note0.md');
    expect(summary.errors[0].skippedPaths).toBeUndefined();
  });
});
