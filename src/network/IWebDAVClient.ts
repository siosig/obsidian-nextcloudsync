import { NextcloudFeatures, RemoteFileInfo, SyncChanges, FileVersion } from '../types';

export interface IWebDAVClient {
  connect(): Promise<NextcloudFeatures>;
  getFiles(path: string): Promise<RemoteFileInfo[]>;
  getChanges(syncToken: string): Promise<SyncChanges>;
  downloadFile(remotePath: string, localTmpPath: string): Promise<void>;
  /** mtime (ms epoch): when provided, sent as X-OC-MTime so Nextcloud preserves the local timestamp. */
  uploadFile(remotePath: string, data: ArrayBuffer, mtime?: number): Promise<void>;
  moveFile(oldPath: string, newPath: string): Promise<void>;
  deleteFile(path: string, expectedRemoteId: string): Promise<void>;
  getSyncToken(): Promise<string | null>;
  /** Returns the ArrayBuffer from the most recent downloadFile() call. */
  getLastDownloadBuffer(): ArrayBuffer;

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
