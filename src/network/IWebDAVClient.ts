import { NextcloudFeatures, RemoteFileInfo, RemoteDirInfo, SyncChanges, FileVersion } from '../types';

export interface IWebDAVClient {
  connect(): Promise<NextcloudFeatures>;
  getFiles(path: string): Promise<RemoteFileInfo[]>;
  /**
   * Returns the ETag of the sync-root collection (the vault folder), or null when it cannot be
   * obtained or is not meaningful for change detection (root-ETag short-circuit, spec 023). Nextcloud
   * propagates child changes up to the root, so a matching root ETag means the remote tree is
   * unchanged since the last full scan. Standard WebDAV returns null (propagation not guaranteed) so
   * it never short-circuits. Implementations must not throw: any failure ⇒ null (caller full-scans).
   */
  getRootEtag(): Promise<string | null>;
  /**
   * List the directories (WebDAV collections) beneath `path` (recursive). Surfaced
   * separately from {@link getFiles} so directories are first-class entities the engine
   * can prune when they become empty. The base folder itself is excluded.
   */
  getDirectories(path: string): Promise<RemoteDirInfo[]>;
  /**
   * True iff the collection at `path` has no children (rmdir semantics — a single
   * Depth:1 probe of the live server). Used immediately before {@link deleteCollection}
   * as the data-loss guard: a recursive collection DELETE must only target an empty dir.
   */
  isRemoteDirEmpty(path: string): Promise<boolean>;
  /**
   * Create a directory (collection) and any missing ancestors via MKCOL. Used to propagate a
   * directory created on a client to the remote — including an EMPTY directory, which is a
   * first-class entity (not derived from whether it holds files). Existing collections are fine.
   */
  createDirectory(path: string): Promise<void>;
  /**
   * DELETE a directory (collection). WebDAV DELETE on a collection is recursive, so callers
   * MUST confirm emptiness via {@link isRemoteDirEmpty} first. A 404 is treated as success.
   */
  deleteCollection(path: string): Promise<void>;
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
  /**
   * Uploads data in chunks. On completion it appears atomically at the final path.
   * @param opts Same optimistic-concurrency/precomputed-hash options as {@link uploadFile} — the
   *        `ifMatchEtag` MUST be applied to the assembling MOVE so a concurrently-changed remote
   *        yields 412 (mapped to PreconditionFailedError) exactly like the single-PUT path.
   */
  uploadChunked(
    remotePath: string, data: ArrayBuffer, chunkSizeBytes: number,
    opts?: { precomputedSha256?: string; ifMatchEtag?: string | null },
  ): Promise<void>;

  // ── US4: Files Locking ──
  /** Acquires a file lock and returns the token. HTTP 423 maps to FileLockedError. */
  lockFile(remotePath: string): Promise<string>;
  /** Releases the lock using the token (best-effort; never throws on failure). */
  unlockFile(remotePath: string, token: string): Promise<void>;
}
