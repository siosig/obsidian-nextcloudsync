// FIFO async mutex. `await` yields the event loop, so concurrent `read state -> await I/O -> write state`
// sequences can interleave and lose an update; `run(fn)` guarantees one `fn` body at a time.
// Guards StateDB mutations and the createdDirs MKCOL cache (docs/plan.md §11).
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    // The tail advances on success or failure alike, so a failing `fn` does not wedge the queue.
    const result = this.tail.then(() => fn());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
