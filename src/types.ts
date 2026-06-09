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
   * (desktop 8 / mobile 2), resolved on first run. No clamping (user value is used as-is).
   */
  networkConcurrency: number;
  /**
   * Sync only on Wi-Fi (non-cellular). Not supported on iOS (no network-type API);
   * the toggle is disabled there and the setting is ignored.
   */
  syncOnWifiOnly: boolean;
  /** Include Obsidian bookmarks (.obsidian/bookmarks.json) in the sync. */
  syncBookmarks: boolean;
  /** Debug mode: "Sync Now" shows a dry-run plan instead of executing the sync. */
  debugMode: boolean;
  /** Enable chunked uploads (default ON; Nextcloud only). */
  chunkedUploadEnabled: boolean;
  /** Enable Files Locking (experimental; default OFF; only on servers that support files_lock). */
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
  maxFileSizeMB: 1024,
  watchOnChangeEnabled: false,
  // Platform-dependent defaults below are finalized on first run in loadSettings():
  //   syncOnStartupEnabled: desktop true / mobile false
  //   networkConcurrency:   desktop 8 / mobile 2
  syncOnStartupEnabled: true,
  startupSyncDelaySeconds: 5,
  networkConcurrency: 8,
  syncOnWifiOnly: false,
  syncBookmarks: false,
  debugMode: false,
  chunkedUploadEnabled: true,
  fileLockingEnabled: false,
  autoMergeEnabled: false,
  maxConflictRegions: 3,
  frontmatterConflictStrategy: 'conflict',
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

export interface SyncSessionSummary {
  startedAt: number;
  completedAt: number | null;
  uploadedCount: number;
  downloadedCount: number;
  deletedCount: number;
  conflictCount: number;
  errorCount: number;
  retriedFiles: string[];
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'conflict';

/** Planned action for a single file in a dry-run (debug) sync preview. */
export type SyncAction =
  | 'upload'
  | 'download'
  | 'merge'
  | 'conflict'
  | 'unchanged'
  | 'delete-local'
  | 'delete-remote';

/** One entry in the debug dry-run plan. */
export interface SyncPlanEntry {
  /** Vault-relative path. */
  path: string;
  action: SyncAction;
  localExists: boolean;
  remoteExists: boolean;
}

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

// ── US3: Chunked Upload (implementation internal) ───────────────────────────

/** Progress state of a chunked upload. */
export interface ChunkUploadSession {
  uploadId: string;
  remotePath: string;
  totalBytes: number;
  chunkSizeBytes: number;
}

// ── US4: Files Locking (implementation internal) ────────────────────────────

/** A held server-side lock. */
export interface FileLock {
  path: string;
  token: string;
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
