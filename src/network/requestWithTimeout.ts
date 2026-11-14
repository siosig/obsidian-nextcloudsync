import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { withCertTrustGuidance } from './certTrust';

// Thin wrapper around requestUrl: an untrusted-server-certificate failure is rethrown with the guidance appended
// (docs/spec.md §11.3); every other outcome passes through unchanged. No timeout and no retry here.
export function requestUrlWithGuidance(params: RequestUrlParam): Promise<RequestUrlResponse> {
  return requestUrl(params).catch((err: unknown) => { throw withCertTrustGuidance(err); });
}

// Obsidian's requestUrl has no timeout or AbortSignal: a half-open socket would hold the engine's
// "running" guard forever. Race it against a timer; on timeout the promise rejects (the request keeps
// running, its result ignored) so the sync fails normally and the next one retries.
// timeoutMs <= 0 or non-finite disables the timeout (escape hatch; default is networkTimeoutSeconds = 30s).
export function requestUrlWithTimeout(params: RequestUrlParam, timeoutMs: number): Promise<RequestUrlResponse> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return requestUrlWithGuidance(params);
  return new Promise<RequestUrlResponse>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(
        `Network request timed out after ${Math.round(timeoutMs / 1000)}s: ${params.method ?? 'GET'} ${params.url}`,
      ));
    }, timeoutMs);
    requestUrlWithGuidance(params).then(
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
