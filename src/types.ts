// Shared type definitions for nextcloud-sync

export interface DavSyncSettings {
  serverUrl: string;
  username: string;
  /**
   * Reference ID for the app password stored in Obsidian SecretStorage.
   * The actual password value is never saved in data.json; secretStorage manages it encrypted.
   */
  passwordSecretId: string;
  syncIntervalMinutes: number;
  networkTimeoutSeconds: number;
  deviceId: string;
  /**
   * Threshold (MB) above which files start chunked uploads.
   * (Meaning changed from the old "skip when exceeded" to "start chunking". 002 spec.)
   */
  uploadChunkThresholdMB: number;
  /** Absolute limit (MB). Files exceeding this are skipped with a warning. `0` = unlimited. */
  maxFileSizeMB: number;
  /** Detect local Markdown edits and sync immediately (watch mode). Disabled on mobile. */
  watchOnChangeEnabled: boolean;
  /**
   * Sync once on startup. Default is platform-dependent (desktop ON / mobile OFF),
   * resolved on first run in loadSettings().
   */
  syncOnStartupEnabled: boolean;
  /** Seconds to wait after startup before the startup sync (when syncOnStartupEnabled). `>= 0`. */
  startupSyncDelaySeconds: number;
  /**
   * Number of concurrent WebDAV requests. Default is platform-dependent
   * (desktop 16 / mobile 2), resolved on first run. No clamping (user value is used as-is).
   */
  networkConcurrency: number;
  /**
   * Sync only on Wi-Fi (non-cellular). Not supported on iOS (no network-type API);
   * the toggle is disabled there and the setting is ignored.
   */
  syncOnWifiOnly: boolean;
  /** Include Obsidian bookmarks (.obsidian/bookmarks.json) in the sync. */
  syncBookmarks: boolean;
  /**
   * User-facing device label. Source of the `<host>` token in per-device log filenames.
   * Empty ⇒ derive `"<platform>-<deviceId6>"`. Sanitized for filenames at use sites.
   */
  deviceName: string;
  /** Vault-relative folder holding both log files. Blank ⇒ vault root. */
  logsFolder: string;
  /** Master on/off for the per-device sync log. */
  syncLogEnabled: boolean;
  /**
   * Which operations the sync log records:
   *   'important' — conflicts, merges, side-wins resolutions, and errors
   *   'all'       — the above plus routine uploads, downloads, and deletions
   */
  syncLogLevel: 'important' | 'all';
  /** Master on/off for the per-device debug log (replaces the old `debugMode`). */
  debugLogEnabled: boolean;
  /** Verbosity threshold for the debug log (order: error < debug < verbose). */
  debugLogLevel: 'error' | 'debug' | 'verbose';
  /** Enable chunked uploads (default ON; Nextcloud only). */
  chunkedUploadEnabled: boolean;
  /** Enable Files Locking (experimental; default ON; only on servers that support files_lock). */
  fileLockingEnabled: boolean;
  autoMergeEnabled: boolean;
  maxConflictRegions: number;
  /**
   * What to do when local and remote frontmatter differ during auto-merge:
   *   'local-wins'  — keep local frontmatter, merge bodies
   *   'remote-wins' — use remote frontmatter, merge bodies
   *   'conflict'    — insert conflict markers for the whole file (default / safe)
   */
  frontmatterConflictStrategy: 'local-wins' | 'remote-wins' | 'conflict';
  /**
   * File extensions (lowercase, no leading dot) that are eligible for text merge.
   * Files whose extension is NOT in this list are never merged; on conflict the
   * `conflictFailurePolicy` is applied directly (never embeds markers into them).
   * Default: ['md', 'txt'].
   */
  mergeableExtensions: string[];
  /**
   * What to do when a merge does not cleanly resolve — i.e. the file is not mergeable,
   * auto-merge is off, or the merge failed / left conflicts:
   *   'error'           — leave BOTH sides untouched, count as an error, retry next sync (default / safe)
   *   'local-wins'      — overwrite the remote with the local copy
   *   'remote-wins'     — overwrite the local with the remote copy
   *   'conflict-markers'— embed <<<<<<< / ======= / >>>>>>> markers (mergeable text only;
   *                       non-mergeable files fall back to 'error')
   */
  conflictFailurePolicy: 'error' | 'local-wins' | 'remote-wins' | 'conflict-markers';
  /**
   * Adds a "Compare with remote" item to the file-explorer right-click menu (desktop).
   * Default OFF — the user opts in. The menu handler reads this on every right-click, so
   * toggling it takes effect immediately without an Obsidian restart.
   */
  explorerCompareEnabled: boolean;
  /**
   * Last Nextcloud server version observed at connect time. Used only to show a
   * recommendation banner in settings when it is below the recommended minimum.
   * Empty/undefined until the first successful connection.
   */
  lastKnownServerVersion?: string;
}

export const DEFAULT_SETTINGS: DavSyncSettings = {
  serverUrl: '',
  username: '',
  passwordSecretId: '',
  syncIntervalMinutes: 15,
  networkTimeoutSeconds: 30,
  deviceId: '',
  uploadChunkThresholdMB: 50,
  maxFileSizeMB: 0, // 0 = unlimited (desktop default). Mobile gets a safe cap in loadSettings().
  watchOnChangeEnabled: true,
  // These are DESKTOP defaults. Mobile-specific overrides are applied on first run in
  // loadSettings(): syncOnStartupEnabled→false, networkConcurrency→2, maxFileSizeMB→20,
  // syncOnWifiOnly→true.
  syncOnStartupEnabled: true,
  startupSyncDelaySeconds: 1,
  networkConcurrency: 16,
  syncOnWifiOnly: false,
  syncBookmarks: true,
  deviceName: '',
  logsFolder: '',
  syncLogEnabled: false,
  syncLogLevel: 'important',
  debugLogEnabled: false,
  debugLogLevel: 'error',
  chunkedUploadEnabled: true,
  fileLockingEnabled: true,
  autoMergeEnabled: true,
  maxConflictRegions: 0,
  frontmatterConflictStrategy: 'conflict',
  mergeableExtensions: ['md', 'txt'],
  conflictFailurePolicy: 'error',
  explorerCompareEnabled: false,
  lastKnownServerVersion: '',
};

export type RemoteIdType = 'sha256' | 'sha1' | 'etag' | 'size';

export interface FileState {
  path: string;
  localHash: string;
  remoteId: string;
  idType: RemoteIdType;
  size: number;
  mtime: number;
  remoteFileId: string | null;
  isConflicted: boolean;
}

export interface SyncState {
  deviceId: string;
  lastSyncTime: number;
  syncToken: string | null;
  files: Record<string, FileState>;
}

export interface NextcloudFeatures {
  isNextcloud: boolean;
  version: string;
  hasChecksums: boolean;
  hasFilesLocking: boolean;
  syncToken: string | null;
}

export interface RemoteFileInfo {
  path: string;
  fileId: string | null;
  checksum: string | null;
  etag: string | null;
  size: number;
  lastModified: number;
}

export interface SyncChanges {
  modified: RemoteFileInfo[];
  deleted: string[];
  newSyncToken: string;
}

export interface MergeResult {
  success: boolean;
  mergedContent: string;
  hadConflicts: boolean;
  conflictRegions: number;
}

/**
 * The action a ConflictResolver decides on for a conflicting file. The decision is pure
 * (no I/O); SyncEngine.handleConflict executes the corresponding network/disk operations.
 *   write         — write `content` locally (clean merge or marker-embedded text), then converge to server
 *   skip          — leave BOTH sides untouched (error policy, or non-text × conflict-markers fallback)
 *   prefer-local  — overwrite the remote with the local copy
 *   prefer-remote — overwrite the local with the remote copy
 */
export type ConflictResolution =
  | { action: 'write'; content: string; clean: boolean }
  | { action: 'skip' }
  | { action: 'prefer-local' }
  | { action: 'prefer-remote' };

/** One recorded sync error: the file it happened on (empty for session-level errors) and why. */
export interface SyncErrorDetail {
  path: string;
  message: string;
}

/** The outcome recorded for a single file during a sync, shown in the status dialog's history. */
export type SyncFileOp =
  | 'uploaded' | 'downloaded' | 'deleted' | 'merged' | 'conflicted'
  | 'local-wins' | 'remote-wins' | 'error';

/** Optional checksum/size detail captured for a sync-history entry (for the sync log). */
export interface SyncHistoryDetail {
  /** Local content checksum (sha256) when known. */
  localHash?: string;
  /** Remote identifier (content hash / etag / size) when known. */
  remoteId?: string;
  /** Qualifies `remoteId` so an etag is not mistaken for a content hash. */
  remoteIdType?: RemoteIdType;
  /** Local file size in bytes when known. */
  localSize?: number;
  /** Remote file size in bytes when known. */
  remoteSize?: number;
}

/** One per-file sync-history entry, persisted across restarts and pruned to a rolling window. */
export interface SyncHistoryEntry extends SyncHistoryDetail {
  path: string;
  op: SyncFileOp;
  /** Epoch milliseconds when the operation was recorded. */
  at: number;
  /** Failure reason — present only for `op: 'error'`. */
  message?: string;
}

export interface SyncSessionSummary {
  startedAt: number;
  completedAt: number | null;
  uploadedCount: number;
  downloadedCount: number;
  deletedCount: number;
  /** Files where both sides existed and auto-merge produced a clean result (no markers). */
  mergedCount: number;
  /** Files where both sides existed and merge left `>>>>` conflict markers for the user. */
  conflictedCount: number;
  errorCount: number;
  retriedFiles: string[];
  /** Per-error details behind errorCount, shown in the sync status dialog. */
  errors: SyncErrorDetail[];
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'conflict';

/** Debug merge preview for a single file: the two sides and the content a sync would write. */
export interface MergePreview {
  path: string;
  localExists: boolean;
  remoteExists: boolean;
  /** Current local content (the "before" side). */
  local: string;
  /** Current remote content. */
  remote: string;
  /** Content a real sync would write (the "after" side): merged result or conflict-marked text. */
  after: string;
  /** True when the merge resolved cleanly with no markers remaining. */
  clean: boolean;
}

/**
 * Read-only comparison of one file against its remote counterpart, for the explorer
 * "Compare with remote" popup. Produced by SyncEngine.compareWithRemote — it never mutates.
 * `state` distinguishes a successful comparison from a missing remote or a fetch failure;
 * the UI shows a separate (non-result) loading state while the promise is pending.
 */
export interface RemoteCompareResult {
  path: string;
  state: 'ok' | 'remote-missing' | 'error';
  /** User-readable failure reason — present only when state === 'error'. */
  errorMessage?: string;
  localExists: boolean;
  remoteExists: boolean;
  /** Modification times (epoch ms); null when the corresponding side is absent. */
  localMtime: number | null;
  remoteMtime: number | null;
  /** Lowercase hex SHA-256 over raw bytes; null when the side is absent. */
  localChecksum: string | null;
  remoteChecksum: string | null;
  /** True iff both checksums are present and equal. */
  checksumMatch: boolean;
  /** Decoded text for the diff; null for binary/non-text files or an absent side. */
  localText: string | null;
  remoteText: string | null;
  /** True only for text-eligible files with both sides present. */
  diffAvailable: boolean;
  /** Sizes in bytes; null when the side is absent. */
  localSize: number | null;
  remoteSize: number | null;
}

// ── US1: Login Flow v2 ──────────────────────────────────────────────────────

/** Login Flow v2 init response (POST /index.php/login/v2). */
export interface LoginFlowInit {
  /** Token used for polling. */
  pollToken: string;
  /** Absolute URL to poll. */
  pollEndpoint: string;
  /** Login approval URL to open in the browser. */
  loginUrl: string;
}

/** Login Flow v2 polling result (discriminated union). */
export type LoginFlowResult =
  | { status: 'success'; server: string; loginName: string; appPassword: string }
  | { status: 'pending' }
  | { status: 'timeout' }
  | { status: 'unsupported' };

// ── US2: File Versions ──────────────────────────────────────────────────────

/** A past version of a single file held on the server. */
export interface FileVersion {
  /** Trailing identifier of versions/{fileId}/{versionId}. */
  versionId: string;
  /** Remote path used for GET/MOVE (the versions namespace, separate from the files root). */
  href: string;
  /** Last modified (epoch milliseconds). */
  lastModified: number;
  /** Size in bytes. */
  size: number;
}

// Custom errors
export class SyncTokenExpiredError extends Error {
  constructor() { super('sync-token expired (HTTP 410)'); this.name = 'SyncTokenExpiredError'; }
}
export class ConflictError extends Error {
  constructor(public readonly path: string) {
    super(`Conflict at ${path}`); this.name = 'ConflictError';
  }
}
export class NetworkError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`HTTP ${status}`); this.name = 'NetworkError';
  }
}
export class MaintenanceModeError extends Error {
  constructor() { super('Nextcloud is in maintenance mode'); this.name = 'MaintenanceModeError'; }
}
export class CredentialsNotFoundError extends Error {
  constructor() { super('App password not found in credentials'); this.name = 'CredentialsNotFoundError'; }
}
/** A Nextcloud-specific feature was invoked on a client that does not support it (standard WebDAV). */
export class FeatureUnsupportedError extends Error {
  constructor(public readonly feature: string) {
    super(`Feature not supported on this server: ${feature}`);
    this.name = 'FeatureUnsupportedError';
  }
}
/** Failed to start or poll Login Flow v2. */
export class LoginFlowError extends Error {
  constructor(public readonly reason: string) {
    super(`Login Flow failed: ${reason}`);
    this.name = 'LoginFlowError';
  }
}
/** The target file is locked by another client (HTTP 423). */
export class FileLockedError extends Error {
  constructor(public readonly path: string) {
    super(`File is locked: ${path}`);
    this.name = 'FileLockedError';
  }
}
