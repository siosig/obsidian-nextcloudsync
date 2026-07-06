import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DEFAULT_SETTINGS } from '../../../src/types';
import { autoNetworkConcurrency } from '../../../src/util/platformDefaults';

// Feature 028: network concurrency is no longer a user setting — the engine reads
// autoNetworkConcurrency(). Tests mock it to exercise the bounded-parallel cap.
jest.mock('../../../src/util/platformDefaults', () => ({
  ...jest.requireActual('../../../src/util/platformDefaults'),
  autoNetworkConcurrency: jest.fn(() => 8),
}));
const mockedConcurrency = autoNetworkConcurrency as jest.Mock;

/**
 * P1-A: the engine's bounded-parallel file runner (runFileBatch). Verifies the safety properties the
 * sync loops rely on: every item runs exactly once, same-directory work is serialized (avoids 423s),
 * and different directories run concurrently.
 */
function makeEngine(networkConcurrency = 8) {
  mockedConcurrency.mockReturnValue(networkConcurrency);
  const opts = {
    app: {}, settings: { networkConcurrency, syncConfigFolder: false, configSync: {} },
    localAdapter: {}, stateDB: {}, statusBar: {}, webdavFactory: {},
    pluginDir: '', configDir: '.obsidian',
  };
  const engine = new SyncEngine(opts as never);
  return (items: Array<{ path: string; size: number }>, worker: (it: { path: string; size: number }) => Promise<void>, serializeByDir: boolean) =>
    (engine as unknown as {
      runFileBatch(
        items: unknown[], pathOf: (it: unknown) => string, sizeOf: (it: unknown) => number,
        worker: (it: unknown) => Promise<void>, serializeByDir: boolean,
      ): Promise<void>;
    }).runFileBatch(items, (it) => (it as { path: string }).path, (it) => (it as { size: number }).size, worker as never, serializeByDir);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SyncEngine.runFileBatch (P1-A bounded parallel)', () => {
  it('runs every item exactly once (no drops, no lost work)', async () => {
    const run = makeEngine(4);
    const seen: string[] = [];
    const items = Array.from({ length: 25 }, (_, i) => ({ path: `dir${i}/f.md`, size: 1 }));
    await run(items, async (it) => { await tick(); seen.push(it.path); }, true);
    expect(seen.sort()).toEqual(items.map((i) => i.path).sort());
  });

  it('serializes same-directory work but overlaps different directories', async () => {
    const run = makeEngine(8);
    const perDirActive: Record<string, number> = {};
    let perDirPeak = 0;
    let globalActive = 0;
    let globalPeak = 0;
    const items = [
      { path: 'a/1.md', size: 1 }, { path: 'a/2.md', size: 1 }, { path: 'a/3.md', size: 1 },
      { path: 'b/1.md', size: 1 }, { path: 'b/2.md', size: 1 },
      { path: 'c/1.md', size: 1 },
    ];
    await run(items, async (it) => {
      const dir = it.path.split('/')[0];
      perDirActive[dir] = (perDirActive[dir] ?? 0) + 1;
      globalActive++;
      perDirPeak = Math.max(perDirPeak, perDirActive[dir]);
      globalPeak = Math.max(globalPeak, globalActive);
      await tick();
      perDirActive[dir]--;
      globalActive--;
    }, true);
    expect(perDirPeak).toBe(1);        // never two workers in the same directory at once
    expect(globalPeak).toBeGreaterThan(1); // different directories did overlap
  });

  it('respects the concurrency cap across directories', async () => {
    const run = makeEngine(2);
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => ({ path: `d${i}/f.md`, size: 1 }));
    await run(items, async () => { active++; peak = Math.max(peak, active); await tick(); active--; }, true);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('SyncEngine — Two-Phase Termination (requestStop)', () => {
  function makeEngineWithStop(networkConcurrency = 2) {
    mockedConcurrency.mockReturnValue(networkConcurrency);
    const opts = {
      app: {}, settings: { networkConcurrency, syncConfigFolder: false, configSync: {} },
      localAdapter: {}, stateDB: {}, statusBar: {}, webdavFactory: {}, pluginDir: '', configDir: '.obsidian',
    };
    const engine = new SyncEngine(opts as never);
    const run = (items: Array<{ path: string; size: number }>, worker: (it: { path: string; size: number }) => Promise<void>) =>
      (engine as unknown as {
        runFileBatch(i: unknown[], p: (it: unknown) => string, s: (it: unknown) => number, w: (it: unknown) => Promise<void>, d: boolean): Promise<void>;
      }).runFileBatch(items, (it) => (it as { path: string }).path, (it) => (it as { size: number }).size, worker as never, true);
    return { engine: engine as unknown as { requestStop(): void }, run };
  }

  it('runs no further workers once stop is requested', async () => {
    const { engine, run } = makeEngineWithStop(2);
    let ran = 0;
    const items = Array.from({ length: 20 }, (_, i) => ({ path: `d${i}/f.md`, size: 1 }));
    await run(items, async () => {
      ran++;
      if (ran === 2) engine.requestStop(); // request stop early
      await tick();
    });
    // After the stop, queued workers no-op; only the already-started ones complete.
    expect(ran).toBeLessThan(items.length);
  });

  it('skips all workers when stopped before the batch starts', async () => {
    const { engine, run } = makeEngineWithStop(2);
    engine.requestStop();
    let ran = 0;
    await run([{ path: 'a/1.md', size: 1 }, { path: 'b/1.md', size: 1 }], async () => { ran++; });
    expect(ran).toBe(0);
  });
});

describe('[SPEC:CONC-1] SyncEngine — a failed ensureClient must not strand the running guard', () => {
  // Regression for feature 053. ensureClient() (client creation + capabilities probe) used to run
  // OUTSIDE runSyncSession's try/finally, so a connection failure stranded `running=true` forever —
  // every later sync balked with "already running" — AND swallowed the real error (no FAILED log).
  // The fix moves ensureClient inside the guard so the failure is caught + logged and the flag is
  // always cleared, letting the next sync retry.
  function makeFailingEngine() {
    const logs: string[] = [];
    const createClient = jest.fn(async () => { throw new Error('boom: capabilities probe failed'); });
    const opts = {
      app: {},
      settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
      localAdapter: {},
      stateDB: {
        setLastSyncTime: jest.fn(),
        save: jest.fn(async () => undefined),
        countConflicted: jest.fn(() => 0),
        getSyncToken: jest.fn(() => null),
        getAllFiles: jest.fn(() => []),
      },
      statusBar: { setStatus: jest.fn(), setSyncComplete: jest.fn() },
      webdavFactory: { createClient },
      logger: { log: jest.fn(async (m: string) => { logs.push(m); }) },
      pluginDir: '', configDir: '.obsidian',
    };
    const engine = new SyncEngine(opts as never) as unknown as { syncManual(o?: { manual?: boolean }): Promise<void> };
    return { engine, createClient, logs };
  }

  it('clears `running` and surfaces the error, so the next sync can retry', async () => {
    // testEnvironment is 'node'; isBlockedByWifiOnly reads navigator.connection. syncOnWifiOnly=false
    // short-circuits, but guard the global so older runtimes without a `navigator` don't ReferenceError.
    (globalThis as { navigator?: unknown }).navigator ??= {};
    const { engine, createClient, logs } = makeFailingEngine();

    // First sync: ensureClient throws. With the fix the error is caught, so syncManual RESOLVES
    // (before the fix it rejected and left `running` stranded).
    await expect(engine.syncManual({ manual: true })).resolves.toBeUndefined();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.startsWith('sync: FAILED'))).toBe(true); // real error surfaced, not swallowed

    // Second sync: must actually run again (running was cleared), NOT balk with "already running".
    await expect(engine.syncManual({ manual: true })).resolves.toBeUndefined();
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(logs.filter((l) => l === 'sync: skipped — already running')).toHaveLength(0);
  });
});
