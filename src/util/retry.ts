import { NetworkError } from '../types';

const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;

/**
 * Exponential backoff retry for network operations.
 * `shouldRetry` defaults to retrying only NetworkError instances; callers can
 * inject their own predicate (e.g. to retry on transient WebDAV timeouts).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = MAX_RETRIES,
  initialDelayMs = INITIAL_DELAY_MS,
  shouldRetry: (err: unknown) => boolean = (err) => err instanceof NetworkError,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err)) throw err;
      if (attempt === maxRetries) break;
      const delay = initialDelayMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}
