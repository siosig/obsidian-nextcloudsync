import { NetworkError } from '../types';

const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;

/** Exponential backoff retry for network operations. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = MAX_RETRIES,
  initialDelayMs = INITIAL_DELAY_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Only retry on transient network errors
      if (!(err instanceof NetworkError)) throw err;
      if (attempt === maxRetries) break;
      const delay = initialDelayMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
