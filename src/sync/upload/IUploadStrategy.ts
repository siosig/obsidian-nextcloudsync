import { IWebDAVClient } from '../../network/IWebDAVClient';

/** Outcome of an upload: skipped (over the size limit) or sent. */
export type UploadOutcome = 'uploaded' | 'skipped';

/** Size limits an upload strategy applies. */
export interface UploadConfig {
  /** Absolute size cap (MB); files above it are skipped. `0` = unlimited. */
  maxFileSizeMB: number;
  /** Size (MB) above which a chunked upload is used instead of a single PUT. */
  uploadChunkThresholdMB: number;
}

/** Optional per-upload hints. */
export interface UploadOptions {
  /** Reuse this already-computed SHA-256 (hex) for the OC-Checksum header instead of re-hashing. */
  precomputedSha256?: string;
  /** Send `If-Match` with this ETag so a remote that changed since then answers 412. */
  ifMatchEtag?: string | null;
}

/** Uploads a file by single PUT, chunked upload or skip, depending on size and server capabilities. */
export interface IUploadStrategy {
  /** Uploads one file; resolves to `'skipped'` when over the size limit. */
  upload(client: IWebDAVClient, remotePath: string, data: ArrayBuffer, mtime?: number, opts?: UploadOptions): Promise<UploadOutcome>;
}
