import { AsyncMutex } from '../../src/util/AsyncMutex';
import { createLimiter, ByteSemaphore } from '../../src/util/ConcurrencyLimiter';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('AsyncMutex', () => {
  it('serializes interleaved read-modify-write so no update is lost', async () => {
    const mutex = new AsyncMutex();
    const shared = { value: 0 };
    // Each task reads, yields (await), then writes read+1. Without the mutex these interleave and
    // the final value is < N (lost updates). With the mutex it must equal N.
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, () =>
        mutex.run(async () => {
          const v = shared.value;
          await tick();
          shared.value = v + 1;
        }),
      ),
    );
    expect(shared.value).toBe(N);
  });

  it('runs sections in FIFO order', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => mutex.run(async () => { await tick(); order.push(n); })));
    expect(order).toEqual([1, 2, 3]);
  });

  it('releases the lock when a section throws (queue not wedged)', async () => {
    const mutex = new AsyncMutex();
    await expect(mutex.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(mutex.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('propagates the section result', async () => {
    const mutex = new AsyncMutex();
    await expect(mutex.run(() => 42)).resolves.toBe(42);
  });
});

describe('createLimiter', () => {
  it('never exceeds maxConcurrent simultaneous tasks', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually ran in parallel
  });

  it('clamps maxConcurrent below 1 to 1 and still completes all tasks', async () => {
    const limit = createLimiter(0);
    const results = await Promise.all([1, 2, 3].map((n) => limit(async () => n * 2)));
    expect(results).toEqual([2, 4, 6]);
  });

  it('propagates task rejections to the caller', async () => {
    const limit = createLimiter(2);
    await expect(limit(async () => { throw new Error('x'); })).rejects.toThrow('x');
  });
});

describe('ByteSemaphore', () => {
  it('never exceeds the byte budget across concurrent acquisitions', async () => {
    const sem = new ByteSemaphore(100);
    let inflight = 0;
    let peak = 0;
    const run = (bytes: number) => (async () => {
      const release = await sem.acquire(bytes);
      inflight += bytes;
      peak = Math.max(peak, inflight);
      await tick();
      inflight -= bytes;
      release();
    })();
    await Promise.all([run(60), run(60), run(60), run(40)]);
    expect(peak).toBeLessThanOrEqual(100);
  });

  it('admits a single oversized file alone (no deadlock)', async () => {
    const sem = new ByteSemaphore(50);
    const release = await sem.acquire(1000); // larger than the whole budget
    expect(typeof release).toBe('function');
    release();
  });

  it('release is idempotent', async () => {
    const sem = new ByteSemaphore(100);
    const r1 = await sem.acquire(100);
    r1();
    r1(); // second call is a no-op (must not over-credit the budget)
    // Budget should be exactly 100 again: a 100-byte acquire succeeds immediately.
    const r2 = await sem.acquire(100);
    expect(typeof r2).toBe('function');
    r2();
  });
});
