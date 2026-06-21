import { SyncEngine } from '../../../src/sync/SyncEngine';

/**
 * P1-A: the engine's bounded-parallel file runner (runFileBatch). Verifies the safety properties the
 * sync loops rely on: every item runs exactly once, same-directory work is serialized (avoids 423s),
 * and different directories run concurrently.
 */
function makeEngine(networkConcurrency = 8) {
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
