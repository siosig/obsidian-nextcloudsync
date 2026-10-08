// Bounded-concurrency primitives for the sync transfer loops (docs/plan.md §11).
// Dependency-free (no p-limit) to keep the mobile bundle small.

export function createLimiter(maxConcurrent: number): <T>(task: () => Promise<T>) => Promise<T> {
  // `|| 1` also guards against NaN/undefined (a missing setting) which would otherwise wedge the queue.
  const limit = Math.max(1, Math.floor(maxConcurrent)) || 1;
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  return <T>(task: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active++;
        // resolve/reject are passed by reference so a non-Error rejection propagates unchanged.
        const settled = Promise.resolve().then(task);
        void settled.then(release, release);
        settled.then(resolve, reject);
      };
      if (active < limit) start();
      else queue.push(start);
    });
  };
}

// A byte budget for in-flight transfers: `requestUrl` buffers whole bodies in memory, so concurrency
// must be bounded by bytes (not just count) to avoid OOM on mobile. `acquire` resolves with an
// idempotent release function.
export class ByteSemaphore {
  private available: number;
  private readonly max: number;
  private readonly waiters: Array<{ bytes: number; grant: () => void }> = [];

  constructor(maxBytes: number) {
    this.max = Math.max(1, Math.floor(maxBytes)) || 1;
    this.available = this.max;
  }

  acquire(bytes: number): Promise<() => void> {
    // Clamp a single request to the whole budget so an oversized file runs solo instead of deadlocking.
    const need = Math.min(Math.max(0, Math.floor(bytes)), this.max);
    return new Promise<() => void>((resolve) => {
      const grant = (): void => {
        this.available -= need;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.available += need;
          this.drain();
        });
      };
      if (need <= this.available) grant();
      else this.waiters.push({ bytes: need, grant });
    });
  }

  // FIFO and head-of-line on purpose: preserves fairness.
  private drain(): void {
    while (this.waiters.length > 0 && this.waiters[0].bytes <= this.available) {
      const w = this.waiters.shift()!;
      w.grant();
    }
  }
}
