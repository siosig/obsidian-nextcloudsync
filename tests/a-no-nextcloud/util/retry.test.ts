import { withRetry } from '../../../src/util/retry';
import { NetworkError } from '../../../src/types';

// [SPEC:RT-2] withRetry() default shouldRetry preserves legacy NetworkError-only behavior,
// while an injected shouldRetry predicate lets callers (e.g. WebDAV client timeout handling)
// override which errors are considered transient and worth retrying.

describe('withRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('(a) without shouldRetry, retries only NetworkError and rethrows other errors immediately', async () => {
    const fn = jest.fn(async () => {
      throw new Error('plain error');
    });

    await expect(withRetry(fn)).rejects.toThrow('plain error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('(b) shouldRetry=() => true retries even a non-NetworkError', async () => {
    const fn = jest.fn(async () => {
      throw new Error('always retry me');
    });

    const promise = withRetry(fn, 2, 10, () => true);
    // Swallow the eventual rejection so it doesn't surface as an unhandled rejection
    // before we've finished advancing timers.
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(20);

    await expect(promise).rejects.toThrow('always retry me');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('(c) shouldRetry=() => false rethrows a NetworkError immediately without retrying', async () => {
    const fn = jest.fn(async () => {
      throw new NetworkError(503, 'service unavailable');
    });

    await expect(withRetry(fn, 5, 1000, () => false)).rejects.toBeInstanceOf(NetworkError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('(d) maxRetries=2 calls fn 3 times total (initial + 2 retries) then rejects', async () => {
    const fn = jest.fn(async () => {
      throw new NetworkError(500, 'boom');
    });

    const promise = withRetry(fn, 2, 10);
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(20);

    await expect(promise).rejects.toBeInstanceOf(NetworkError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('(e) backoff delay grows exponentially from initialDelayMs', async () => {
    const fn = jest.fn(async () => {
      throw new NetworkError(500, 'boom');
    });

    const promise = withRetry(fn, 2, 1000);
    promise.catch(() => undefined);

    // Before the first retry delay elapses, fn should have been called only once.
    expect(fn).toHaveBeenCalledTimes(1);

    // Advance just short of the first backoff (1000ms) — no second call yet.
    await jest.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);

    // Cross the 1000ms threshold — second call happens.
    await jest.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    // Advance just short of the second backoff (2000ms) — no third call yet.
    await jest.advanceTimersByTimeAsync(1999);
    expect(fn).toHaveBeenCalledTimes(2);

    // Cross the 2000ms threshold — third call happens.
    await jest.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(promise).rejects.toBeInstanceOf(NetworkError);
  });

  it('(f) resolves with the return value once fn eventually succeeds', async () => {
    let attempts = 0;
    const fn = jest.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new NetworkError(500, 'boom');
      return 'success value';
    });

    const promise = withRetry(fn, 5, 10);

    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toBe('success value');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
