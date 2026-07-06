import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';

/**
 * Wrap Obsidian's {@link requestUrl} with a hard timeout.
 *
 * Obsidian's `requestUrl` has no built-in timeout and accepts no `AbortSignal`, so a server that
 * accepts the TCP/TLS connection but never sends a response (half-open socket, stalled proxy, hung
 * captive portal) would leave the request pending forever. Because a sync holds the engine's
 * `running` guard for the duration of its awaits, one such request would strand the whole engine as
 * "sync in progress" indefinitely (feature 053 clears the flag on failure — but only once the await
 * actually settles, which a hang never does).
 *
 * We race the request against a timer. On timeout the returned promise rejects; the underlying
 * `requestUrl` keeps running but its result is ignored (there is no way to cancel it). The sync's
 * guarded try/finally turns the rejection into an ordinary failure — logged, surfaced, `running`
 * cleared — so the next sync retries instead of the engine locking up.
 *
 * `timeoutMs <= 0` (or non-finite) disables the timeout and awaits unboundedly — a deliberate
 * escape hatch, never the default (the default is `networkTimeoutSeconds` = 30s).
 */
export function requestUrlWithTimeout(params: RequestUrlParam, timeoutMs: number): Promise<RequestUrlResponse> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return requestUrl(params);
  return new Promise<RequestUrlResponse>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(
        `Network request timed out after ${Math.round(timeoutMs / 1000)}s: ${params.method ?? 'GET'} ${params.url}`,
      ));
    }, timeoutMs);
    requestUrl(params).then(
      (res) => { if (!settled) { settled = true; window.clearTimeout(timer); resolve(res); } },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
