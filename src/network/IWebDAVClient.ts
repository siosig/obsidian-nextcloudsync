import { NextcloudFeatures, RemoteFileInfo, SyncChanges, FileVersion } from '../types';

export interface IWebDAVClient {
  connect(): Promise<NextcloudFeatures>;
  getFiles(path: string): Promise<RemoteFileInfo[]>;
  getChanges(syncToken: string): Promise<SyncChanges>;
  /**
   * Download a remote file and RETURN its bytes. Returning the buffer (rather than stashing it in a
   * shared field) is required for correctness under concurrent downloads — a shared "last download"
   * field would race and hand a worker another file's bytes.
   */
  downloadFile(remotePath: string): Promise<ArrayBuffer>;
  /**
   * Upload via single PUT.
   * @param mtime ms epoch — when provided, sent as X-OC-MTime so Nextcloud preserves the timestamp.
   * @param opts.precomputedSha256 reuse instead of re-hashing for the OC-Checksum header.
   * @param opts.ifMatchEtag when set, sent as `If-Match` so a concurrently-changed remote yields 412
   *        (mapped to PreconditionFailedError) — optimistic concurrency in place of locking.
   */
  uploadFile(
    remotePath: string, data: ArrayBuffer, mtime?: number,
    opts?: { precomputedSha256?: string; ifMatchEtag?: string | null },
  ): Promise<void>;
  moveFile(oldPath: string, newPath: string): Promise<void>;
  deleteFile(path: string, expectedRemoteId: string): Promise<void>;
  getSyncToken(): Promise<string | null>;
  /**
   * Targeted existence check for a single remote path (PROPFIND Depth 0).
   * Returns true if present, false only on a definitive 404. On any other/uncertain outcome it
   * returns true (conservative) so callers never treat an ambiguous result as "deleted".
   */
  remoteExists(remotePath: string): Promise<boolean>;

  /**
   * Ask the server to compute and persist the SHA-256 checksum of an existing remote file
   * (no download). Returns the lowercase hex digest, or null when unsupported/unavailable.
   * Used during the initial sync to recognise already-identical files without transferring them.
   */
  recalcChecksum(remotePath: string): Promise<string | null>;

  // ── US2: Version history (clients that don't support it throw FeatureUnsupportedError) ──
  /** Returns the list of versions for fileId, newest first. */
  listVersions(fileId: string): Promise<FileVersion[]>;
  /** Retrieves the content of the given version. */
  getVersionContent(version: FileVersion, fileId: string): Promise<ArrayBuffer>;
  /** Restores the given version as the current file on the server (MOVE restore). */
  restoreVersion(version: FileVersion, fileId: string): Promise<void>;

  // ── US3: Chunked upload ──
  /** Uploads data in chunks. On completion it appears atomically at the final path. */
  uploadChunked(remotePath: string, data: ArrayBuffer, chunkSizeBytes: number): Promise<void>;

  // ── US4: Files Locking ──
  /** Acquires a file lock and returns the token. HTTP 423 maps to FileLockedError. */
  lockFile(remotePath: string): Promise<string>;
  /** Releases the lock using the token (best-effort; never throws on failure). */
  unlockFile(remotePath: string, token: string): Promise<void>;
}
