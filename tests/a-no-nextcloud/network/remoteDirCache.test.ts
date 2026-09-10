// Feature 088 (specs/088-mkcol-single-flight): the cache that decides whether a remote directory
// exists. It holds exactly three states — proven / in-flight / unknown (data-model.md) — and there
// is deliberately NO "failed" state: a failed MKCOL drops the path back to unknown so the next
// request may try again (MSF-3).
//
// This file is the unit-level guarantee for contracts C-1 (ensure) and C-2 (forgetAncestorsOf).
// The client-level behaviour built on top of it (ensureRemoteDir, upload/move recovery) lives in
// dirCreateUpload.test.ts, and the engine-level behaviour in sync/nestedFolderUpload.test.ts.
//
// Concurrency here is DETERMINISTIC, never timer-based: `mkcol` hands back a deferred whose
// settlement this file controls, so "N callers, one MKCOL" is asserted while the single MKCOL is
// still outstanding — there is no window in which a wrong implementation could pass by luck.
import { MkcolFn, RemoteDirCache } from '../../../src/network/RemoteDirCache';
import { NetworkError, RemoteDirCreateError } from '../../../src/types';

/** A promise whose settlement this test file controls. */
interface Deferred {
  promise: Promise<number>;
  resolve(status: number): void;
  reject(err: unknown): void;
}

function deferred(): Deferred {
  let resolve!: (status: number) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<number>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A `mkcol` stand-in that records every call and hands back a deferred per call. Nothing settles
 * until this test file says so, which is what makes the single-flight assertions decisive.
 */
function controlledMkcol(): {
  fn: MkcolFn;
  calls: string[];
  callsFor(path: string): number;
  /** Settle the oldest outstanding call for `path` with an HTTP status. */
  settle(path: string, status: number): void;
  /** Settle the oldest outstanding call for `path` by throwing. */
  throwFor(path: string, err: unknown): void;
} {
  const calls: string[] = [];
  const outstanding = new Map<string, Deferred[]>();
  const take = (path: string): Deferred => {
    const queue = outstanding.get(path);
    if (!queue || queue.length === 0) throw new Error(`no outstanding mkcol for '${path}'`);
    return queue.shift() as Deferred;
  };
  return {
    fn: (path: string) => {
      calls.push(path);
      const d = deferred();
      const queue = outstanding.get(path) ?? [];
      queue.push(d);
      outstanding.set(path, queue);
      return d.promise;
    },
    calls,
    callsFor: (path: string) => calls.filter((p) => p === path).length,
    settle: (path: string, status: number) => take(path).resolve(status),
    throwFor: (path: string, err: unknown) => take(path).reject(err),
  };
}

/** Let every already-queued microtask run, without depending on any timer duration. */
const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** Settle a promise into a discriminated outcome so several of them can be inspected together. */
async function outcome(p: Promise<void>): Promise<{ ok: true } | { ok: false; err: unknown }> {
  try {
    await p;
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

/** An mkcol that answers immediately with a fixed status — for arranging a proven path. */
const immediate = (status: number): MkcolFn => jest.fn(() => Promise.resolve(status));

const CONCURRENCY: ReadonlyArray<number> = [2, 4, 8];

/** The statuses that prove existence, and the ones that prove nothing (spec.md MSF-5). */
const PROVING: ReadonlyArray<[string, number]> = [
  ['201 created', 201],
  ['405 already exists', 405],
];
const NOT_PROVING: ReadonlyArray<[string, number]> = [
  ['409 conflict — the parent is missing', 409],
  ['423 locked', 423],
  ['500 server error', 500],
  ['502 bad gateway', 502],
  ['401 unauthorized', 401],
  ['403 forbidden', 403],
];

describe('RemoteDirCache — one MKCOL per directory, and only success is remembered (feature 088)', () => {
  describe('MSF-1 ensure collapses concurrent requests for the same path into a single MKCOL', () => {
    it.each(CONCURRENCY)('%i concurrent callers issue exactly one MKCOL', async (n) => {
      const cache = new RemoteDirCache();
      const mkcol = controlledMkcol();

      // Start all N synchronously: a correct implementation registers the in-flight entry before
      // it yields, so callers 2..N find it and never reach mkcol.
      const pending = Array.from({ length: n }, () => cache.ensure('F/sub', mkcol.fn));
      await flush();
      expect(mkcol.calls).toEqual(['F/sub']);

      mkcol.settle('F/sub', 201);
      await expect(Promise.all(pending)).resolves.toHaveLength(n);
      expect(mkcol.callsFor('F/sub')).toBe(1);
    });

    it('a caller that arrives while the MKCOL is outstanding shares its result', async () => {
      const cache = new RemoteDirCache();
      const mkcol = controlledMkcol();

      const first = cache.ensure('F', mkcol.fn);
      await flush();
      const late = cache.ensure('F', mkcol.fn); // arrives mid-flight
      await flush();
      expect(mkcol.callsFor('F')).toBe(1);

      mkcol.settle('F', 201);
      await expect(first).resolves.toBeUndefined();
      await expect(late).resolves.toBeUndefined();
      expect(mkcol.callsFor('F')).toBe(1);
    });

    it('MSF-5 a proven path resolves without calling mkcol again', async () => {
      const cache = new RemoteDirCache();
      const mkcol = immediate(201);
      await cache.ensure('F', mkcol);
      expect(mkcol).toHaveBeenCalledTimes(1);

      const later = immediate(201);
      await cache.ensure('F', later);
      await cache.ensure('F', later);
      expect(later).not.toHaveBeenCalled();
    });

    it('clear() drops what was proven, so the next ensure issues a fresh MKCOL', async () => {
      const cache = new RemoteDirCache();
      await cache.ensure('F', immediate(201));

      cache.clear();
      const afterClear = immediate(201);
      await cache.ensure('F', afterClear);
      expect(afterClear).toHaveBeenCalledTimes(1);
    });
  });

  describe('MSF-2 when the single MKCOL fails, every waiter sees that same failure', () => {
    it.each(CONCURRENCY)('all %i callers reject with the identical error — none resolves', async (n) => {
      const cache = new RemoteDirCache();
      const mkcol = controlledMkcol();

      const pending = Array.from({ length: n }, () => cache.ensure('F/sub', mkcol.fn));
      const results = pending.map((p) => outcome(p));
      await flush();
      expect(mkcol.callsFor('F/sub')).toBe(1);

      mkcol.settle('F/sub', 500);
      const settled = await Promise.all(results);

      expect(settled.every((r) => !r.ok)).toBe(true);
      for (const r of settled) {
        expect(r.ok).toBe(false);
        const err = (r as { ok: false; err: unknown }).err;
        expect(err).toBeInstanceOf(RemoteDirCreateError);
        expect((err as RemoteDirCreateError).dirPath).toBe('F/sub');
        expect((err as RemoteDirCreateError).status).toBe(500);
      }
      // "The same failure" — not merely equal-looking ones per waiter.
      const firstErr = (settled[0] as { ok: false; err: unknown }).err;
      for (const r of settled) expect((r as { ok: false; err: unknown }).err).toBe(firstErr);
    });

    it('MSF-1 a single caller that fails produces no unhandled rejection (C-1)', async () => {
      // The trap this guards: an implementation that stores a DERIVED promise (mkcol().then(cleanup))
      // in the in-flight map and returns a different one. Nobody awaits the stored promise, so its
      // rejection escapes to the process even though the caller handled its own.
      const captured: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        captured.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const cache = new RemoteDirCache();
        await expect(cache.ensure('F', immediate(500))).rejects.toBeInstanceOf(RemoteDirCreateError);
        await flush();
        await flush(); // node reports unhandled rejections once the microtask queue has drained
        expect(captured).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('MSF-1 a waiter that joins mid-flight also sees the failure', async () => {
      const cache = new RemoteDirCache();
      const mkcol = controlledMkcol();

      const first = outcome(cache.ensure('F', mkcol.fn));
      await flush();
      const late = outcome(cache.ensure('F', mkcol.fn));
      await flush();
      expect(mkcol.callsFor('F')).toBe(1);

      mkcol.settle('F', 502);
      expect((await first).ok).toBe(false);
      expect((await late).ok).toBe(false);
    });
  });

  describe('MSF-3 a failure is not remembered — the next ensure tries again', () => {
    it('issues exactly one new MKCOL immediately after a failed one', async () => {
      const cache = new RemoteDirCache();
      const mkcol = controlledMkcol();

      const failing = outcome(cache.ensure('F', mkcol.fn));
      await flush();
      mkcol.settle('F', 500);
      expect((await failing).ok).toBe(false);
      expect(mkcol.callsFor('F')).toBe(1);

      // Immediately afterwards, with no delay of any kind.
      const retry = cache.ensure('F', mkcol.fn);
      await flush();
      expect(mkcol.callsFor('F')).toBe(2);

      mkcol.settle('F', 201);
      await expect(retry).resolves.toBeUndefined();
    });

    it('a retry that succeeds makes the path proven, so a third ensure issues nothing', async () => {
      const cache = new RemoteDirCache();
      const first = immediate(423);
      await expect(cache.ensure('F', first)).rejects.toBeInstanceOf(RemoteDirCreateError);

      const second = immediate(201);
      await cache.ensure('F', second);
      expect(second).toHaveBeenCalledTimes(1);

      const third = immediate(201);
      await cache.ensure('F', third);
      expect(third).not.toHaveBeenCalled();
    });

    it('MSF-2 concurrent callers arriving after a failure share one NEW MKCOL, not the dead one', async () => {
      const cache = new RemoteDirCache();
      const mkcol = controlledMkcol();

      const round1 = outcome(cache.ensure('F', mkcol.fn));
      await flush();
      mkcol.settle('F', 500);
      expect((await round1).ok).toBe(false);

      const round2 = [cache.ensure('F', mkcol.fn), cache.ensure('F', mkcol.fn), cache.ensure('F', mkcol.fn)];
      await flush();
      expect(mkcol.callsFor('F')).toBe(2); // one from round 1, one shared by all of round 2

      mkcol.settle('F', 405);
      await expect(Promise.all(round2)).resolves.toHaveLength(3);
    });
  });

  describe('MSF-4 different paths never block each other', () => {
    it('three distinct paths have their MKCOLs in flight at the same time', async () => {
      const cache = new RemoteDirCache();
      const mkcol = controlledMkcol();

      const f = cache.ensure('F', mkcol.fn);
      const g = cache.ensure('G', mkcol.fn);
      const h = cache.ensure('H/sub', mkcol.fn);
      await flush();

      // Nothing has settled yet, and all three are already outstanding: no serialization.
      expect(mkcol.calls.slice().sort()).toEqual(['F', 'G', 'H/sub']);

      mkcol.settle('G', 201);
      await expect(g).resolves.toBeUndefined();

      // F's failure does not touch H, and H can settle independently.
      mkcol.settle('F', 500);
      expect((await outcome(f)).ok).toBe(false);
      mkcol.settle('H/sub', 405);
      await expect(h).resolves.toBeUndefined();
    });

    it('a path stuck in flight does not delay an unrelated path', async () => {
      const cache = new RemoteDirCache();
      const mkcol = controlledMkcol();

      const stuck = cache.ensure('Slow', mkcol.fn); // never settled during this assertion
      const fast = cache.ensure('Fast', mkcol.fn);
      await flush();
      mkcol.settle('Fast', 201);
      await expect(fast).resolves.toBeUndefined();

      mkcol.settle('Slow', 201);
      await expect(stuck).resolves.toBeUndefined();
    });
  });

  describe('MSF-5 only 201 and 405 prove existence', () => {
    it.each(PROVING)('%s resolves and is remembered', async (_label, status) => {
      const cache = new RemoteDirCache();
      await expect(cache.ensure('F', immediate(status))).resolves.toBeUndefined();

      const next = immediate(201);
      await cache.ensure('F', next);
      expect(next).not.toHaveBeenCalled(); // proven: no second MKCOL
    });

    it.each(NOT_PROVING)('%s rejects with RemoteDirCreateError and is NOT remembered', async (_label, status) => {
      const cache = new RemoteDirCache();
      const err: unknown = await cache.ensure('F/sub', immediate(status)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RemoteDirCreateError);
      expect(err).toBeInstanceOf(NetworkError); // C-5: rides the existing per-file retry handling
      const e = err as RemoteDirCreateError;
      expect(e.dirPath).toBe('F/sub'); // the LEVEL that failed, not a file path
      expect(e.status).toBe(status);
      expect(e.message).not.toContain('\n'); // one line, for one log line
      expect(e.message).toContain('F/sub');
      expect(e.message).toContain(String(status));

      const next = immediate(201);
      await cache.ensure('F/sub', next);
      expect(next).toHaveBeenCalledTimes(1); // unknown again, so a fresh MKCOL goes out
    });

    it('an mkcol that throws rejects with RemoteDirCreateError (status 0) and is NOT remembered', async () => {
      const cache = new RemoteDirCache();
      const thrown = new Error('socket hang up');
      const err: unknown = await cache
        .ensure('F', jest.fn(() => Promise.reject(thrown)))
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RemoteDirCreateError);
      const e = err as RemoteDirCreateError;
      expect(e.dirPath).toBe('F');
      expect(e.status).toBe(0); // no HTTP status exists for an exception
      expect(e.message).not.toContain('\n');
      expect(e.message).toContain('socket hang up'); // C-5: the original wording survives

      const next = immediate(201);
      await cache.ensure('F', next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('an mkcol that throws synchronously is treated the same way', async () => {
      const cache = new RemoteDirCache();
      const err: unknown = await cache
        .ensure('F', (() => {
          throw new Error('boom');
        }) as MkcolFn)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RemoteDirCreateError);
      expect((err as RemoteDirCreateError).status).toBe(0);

      const next = immediate(201);
      await cache.ensure('F', next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('MSF-5 forgetAncestorsOf drops proven ancestors only (C-2)', () => {
    it('MSF-1 removes every proven ancestor of the file, so the next ensure re-issues MKCOL', async () => {
      const cache = new RemoteDirCache();
      await cache.ensure('F', immediate(201));
      await cache.ensure('F/sub', immediate(201));

      cache.forgetAncestorsOf('F/sub/a.md');

      const after = controlledMkcol();
      const f = cache.ensure('F', after.fn);
      const sub = cache.ensure('F/sub', after.fn);
      await flush();
      expect(after.calls.slice().sort()).toEqual(['F', 'F/sub']);

      after.settle('F', 201);
      after.settle('F/sub', 201);
      await expect(Promise.all([f, sub])).resolves.toHaveLength(2);
    });

    it('leaves unrelated proven paths alone', async () => {
      const cache = new RemoteDirCache();
      await cache.ensure('F', immediate(201));
      await cache.ensure('G', immediate(201));
      await cache.ensure('F/sub', immediate(201));

      cache.forgetAncestorsOf('F/sub/a.md');

      const untouched = immediate(201);
      await cache.ensure('G', untouched);
      expect(untouched).not.toHaveBeenCalled();
    });

    it('MSF-1 does NOT touch an in-flight entry — the outstanding MKCOL stays shared (US3-5)', async () => {
      const cache = new RemoteDirCache();
      const mkcol = controlledMkcol();

      const first = cache.ensure('F', mkcol.fn); // in flight, not yet proven
      await flush();
      expect(mkcol.callsFor('F')).toBe(1);

      cache.forgetAncestorsOf('F/a.md');

      const second = cache.ensure('F', mkcol.fn);
      await flush();
      expect(mkcol.callsFor('F')).toBe(1); // still one: the in-flight entry survived the forget

      mkcol.settle('F', 201);
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    });

    it('is a no-op for a path that was never proven', async () => {
      const cache = new RemoteDirCache();
      expect(() => cache.forgetAncestorsOf('Never/Seen/a.md')).not.toThrow();

      const mkcol = immediate(201);
      await cache.ensure('Never', mkcol);
      expect(mkcol).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for a file at the vault root (no ancestors)', async () => {
      const cache = new RemoteDirCache();
      await cache.ensure('F', immediate(201));

      expect(() => cache.forgetAncestorsOf('a.md')).not.toThrow();

      const untouched = immediate(201);
      await cache.ensure('F', untouched);
      expect(untouched).not.toHaveBeenCalled(); // 'F' is not an ancestor of a root-level file
    });

    it('forgets deep ancestors at every level, not just the immediate parent', async () => {
      const cache = new RemoteDirCache();
      for (const p of ['F', 'F/x', 'F/x/y', 'F/x/y/z']) await cache.ensure(p, immediate(201));

      cache.forgetAncestorsOf('F/x/y/z/deep.md');

      const after = controlledMkcol();
      const pending = ['F', 'F/x', 'F/x/y', 'F/x/y/z'].map((p) => cache.ensure(p, after.fn));
      await flush();
      expect(after.calls.slice().sort()).toEqual(['F', 'F/x', 'F/x/y', 'F/x/y/z']);

      for (const p of ['F', 'F/x', 'F/x/y', 'F/x/y/z']) after.settle(p, 201);
      await expect(Promise.all(pending)).resolves.toHaveLength(4);
    });
  });
});

describe('MSF-1 clear() leaves an in-flight MKCOL alone', () => {
  it('MSF-1 MSF-5: a MKCOL already out survives clear() and still proves its own path', async () => {
    // createVaultRoot calls clear() when the vault folder turns out to have been absent. Dropping an
    // in-flight entry there would strand whoever is waiting on it, and the MKCOL it is waiting for
    // really does create the folder — so its result is worth keeping (plan.md, contract C-2).
    const cache = new RemoteDirCache();
    const mkcol = controlledMkcol();
    const first = cache.ensure('F', mkcol.fn);
    await flush();
    expect(mkcol.callsFor('F')).toBe(1);

    cache.clear();
    mkcol.settle('F', 201);
    await first;

    const again = immediate(201);
    await cache.ensure('F', again);
    expect(again).not.toHaveBeenCalled(); // proven by the MKCOL that clear() did not cancel
  });
});
