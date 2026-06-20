/**
 * Bounded-concurrency primitives for the sync transfer loops (research R5 / contracts/concurrency.md).
 * Dependency-free (no p-limit) to keep the mobile bundle small and the behavior testable.
 */

/**
 * Create a limiter that runs at most `maxConcurrent` tasks at once; excess tasks queue and start as
 * slots free. Each task's result/throw is returned to its caller. `maxConcurrent < 1` is clamped to 1.
 */
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
        // Run the task; free the slot when it settles, then forward its result/rejection faithfully.
        // (resolve/reject are passed by reference so a non-Error task rejection propagates unchanged.)
        const settled = Promise.resolve().then(task);
        void settled.then(release, release);
        settled.then(resolve, reject);
      };
      if (active < limit) start();
      else queue.push(start);
    });
  };
}

/**
 * A byte budget for in-flight transfers. `requestUrl` buffers whole bodies in memory, so concurrency
 * must be bounded by total bytes (not just count) to avoid OOM on mobile. A task acquires its size
 * before reading the file; a file LARGER than the whole budget is admitted alone (acquires the full
 * budget) so it can never deadlock. `acquire` resolves with an idempotent release function.
 */
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

  /** Grant queued waiters in FIFO order while the head fits (head-of-line to preserve fairness). */
  private drain(): void {
    while (this.waiters.length > 0 && this.waiters[0].bytes <= this.available) {
      const w = this.waiters.shift()!;
      w.grant();
    }
  }
}
