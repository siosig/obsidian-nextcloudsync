/**
 * A minimal FIFO async mutex: serializes async critical sections so that read-modify-write sequences
 * are never interleaved under bounded concurrency. JavaScript is single-threaded, but `await` yields
 * the event loop, so two concurrent tasks doing `read state → await I/O → write state` can interleave
 * and lose an update. Wrapping the state mutation in `mutex.run(fn)` guarantees one `fn` body at a time.
 *
 * Used to protect StateDB mutations and the createdDirs MKCOL cache when the engine runs file ops in
 * parallel (see research R5 / contracts/concurrency.md). Dependency-free for the mobile bundle.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Run `fn` once the mutex is free; subsequent callers queue FIFO behind it. The returned promise
   * resolves/rejects with `fn`'s result. A throwing/rejecting `fn` releases the lock for the next
   * waiter (the rejection still propagates to this caller).
   */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    // Chain on the current tail; advance the tail to this section's completion (success OR failure),
    // so a failure does not wedge the queue.
    const result = this.tail.then(() => fn());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
