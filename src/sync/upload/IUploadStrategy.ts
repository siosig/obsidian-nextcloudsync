import { IWebDAVClient } from '../../network/IWebDAVClient';

/** Result of an upload: either skipped (over the size limit) or sent. */
export type UploadOutcome = 'uploaded' | 'skipped';

/** Optional per-upload hints (P1-B / P1-C). */
export interface UploadOptions {
  /** Reuse this already-computed SHA-256 (hex) for the OC-Checksum header instead of re-hashing. */
  precomputedSha256?: string;
  /**
   * Send `If-Match: "<etag>"` so a remote that changed since this validator returns 412 (turned into
   * a conflict by the engine) — optimistic concurrency in place of file locking (default-OFF).
   */
  ifMatchEtag?: string | null;
}

/**
 * Upload strategy (DIP). Switches between single PUT / chunked upload / skip
 * depending on file size and server capabilities.
 */
export interface IUploadStrategy {
  /**
   * Upload a file.
   * @returns 'skipped' when skipped due to the size limit, 'uploaded' when sent.
   */
  upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer, mtime?: number, opts?: UploadOptions): Promise<UploadOutcome>;
}
