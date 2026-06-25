// Shared type definitions for nextcloud-sync

/**
 * Per-category opt-in flags for `.obsidian` config-folder sync (issue #1), modelled on
 * Obsidian native Sync's "Vault configuration sync". Each flag is only consulted when the
 * master `syncConfigFolder` setting is on. Community plugins and the plugin's own sync-state
 * DB are intentionally NOT representable here — they are permanent hard exclusions.
 */
export interface ConfigSyncCategories {
  /** appearance.json, app.json */
  appearance: boolean;
  /** themes/**, snippets/** */
  themesSnippets: boolean;
  /** hotkeys.json */
  hotkeys: boolean;
  /** core-plugins.json, graph.json, and the bundled core-plugin config files (fixed allowlist) */
  corePlugins: boolean;
  /** bookmarks.json (migrated from the former standalone `syncBookmarks` setting) */
  bookmarks: boolean;
}

export interface DavSyncSettings {
  serverUrl: string;
  username: string;
  /**
   * Reference ID for the app password stored in Obsidian SecretStorage.
   * The actual password value is never saved in data.json; secretStorage manages it encrypted.
   */
  passwordSecretId: string;
  /** Auto-sync period in minutes. 0 = manual only. Disabled on mobile (the OS suspends timers). */
  syncIntervalMinutes: number;
  deviceId: string;
  /**
   * Sync only on Wi-Fi (non-cellular). Not supported on iOS (no network-type API);
   * the toggle is disabled there and the setting is ignored.
   */
  syncOnWifiOnly: boolean;
  /**
   * Master opt-in for syncing parts of the Obsidian config folder (Vault#configDir, e.g. `.obsidian`).
   * Default OFF. While off, nothing under the config folder is synced (notes-only behaviour).
   * When on, the individual `configSync` categories below decide what is included.
   * Community plugins (`<configDir>/plugins/`) and this plugin's own state DB are NEVER synced,
   * regardless of these flags.
   */
  syncConfigFolder: boolean;
  /** Per-category opt-in for config-folder sync. Only consulted when `syncConfigFolder` is true. */
  configSync: ConfigSyncCategories;
  /**
   * Master troubleshooting-logs toggle (feature 028). When on: the sync log records 'all', the
   * debug log records 'verbose', both written to the vault root. Replaces the former separate
   * syncLog/debugLog enable + level + folder settings (removed in the simplification). The
   * fixed/auto values for the other former settings live in fixedConfig.ts / platformDefaults.ts.
   */
  loggingEnabled: boolean;
  /**
   * User-managed list of vault-relative folder paths that are never synced (feature 027).
   * Folder-prefix match at a folder boundary; entries are normalized and unique. This is an
   * additive layer on top of the permanent hard exclusions (dotfolders, community plugins,
   * the plugin's own state DB), which always apply regardless of this list.
   */
  excludedFolders: string[];
  /**
   * Persisted Sync Status dialog filter selection: the checked status keys, serialized as an array.
   * Absent ⇒ all statuses shown (default). Restored on load and saved on every toggle, so the
   * selection survives an Obsidian restart. Unknown keys are ignored on load.
   */
  statusFilter?: SyncFileOp[];
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
  deviceId: '',
  // Desktop default OFF; mobile's first run flips it ON in loadSettings() (metered data).
  syncOnWifiOnly: false,
  // Config-folder sync is opt-in: master defaults OFF, so a fresh install syncs notes only.
  // These category defaults take effect only once the user turns the master on.
  // Migrated `syncBookmarks: true` users get bookmarks-only instead
  // (see migrateBookmarksToConfigSync); `syncBookmarks` itself is removed and pruned.
  syncConfigFolder: false,
  configSync: {
    appearance: true,
    themesSnippets: true,
    hotkeys: true,
    corePlugins: false,
    bookmarks: true,
  },
  loggingEnabled: false,
  excludedFolders: [],
  // Explicit `undefined` keeps the key in the allowlist used by pruneObsoleteSettings (so a saved
  // selection is never pruned) while meaning "no saved selection → all statuses shown".
  statusFilter: undefined,
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
  /**
   * Local stat signature captured by re-stat IMMEDIATELY AFTER the plugin's own write/download.
   * This is the change-detection fast-path key that works on mobile, where `setMtime()` is a no-op
   * (Node fs.utimes is desktop-only) so the on-disk mtime never matches the remote mtime. Optional
   * for backward compatibility: a state file without these triggers exactly one reconciling hash,
   * after which the fields are populated. See data-model.md §1.
   */
  localMtime?: number;
  /** Local size observed at the same moment as `localMtime` (see above). */
  localSize?: number;
  /**
   * Server `lastModified` for the last converged state, kept separate from `localMtime` so remote
   * change detection is unaffected by the local write timestamp.
   */
  remoteMtime?: number;
}

/**
 * A tracked directory (WebDAV collection). Directories are first-class, contentless entities,
 * symmetric with files: a directory present on one side and absent on the other is a creation or
 * a deletion to propagate — NOT something derived from whether it holds files. `remoteFileId`
 * (oc:fileid) is stable across MOVE for rename detection.
 */
export interface DirState {
  path: string;
  remoteFileId: string | null;
}

export interface SyncState {
  deviceId: string;
  lastSyncTime: number;
  syncToken: string | null;
  files: Record<string, FileState>;
  /** Tracked directories (optional for back-compat with pre-DP v1 state files → defaults to {}). */
  directories?: Record<string, DirState>;
  /**
   * Root-ETag short-circuit (spec 023): the vault root collection's ETag captured at the end of the
   * last REAL full scan. Optional for back-compat (absent ⇒ next sync does a real full scan). A
   * matching current root ETag means the remote tree is unchanged since that scan, so the remote
   * listing can be rebuilt from `files`/`directories` instead of a Depth:infinity PROPFIND.
   */
  remoteRootEtag?: string | null;
  /** Consecutive short-circuited full-scans since the last real scan (FORCE_FULL_SCAN_EVERY bounds it). */
  fullScanSkipCount?: number;
}

export interface NextcloudFeatures {
  isNextcloud: boolean;
  version: string;
  hasChecksums: boolean;
  hasFilesLocking: boolean;
  /** Server advertises (or feature-probed positive for) the bulk-upload endpoint `/remote.php/dav/bulk`. */
  hasBulkUpload: boolean;
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

/**
 * A remote directory (WebDAV collection). Directories carry no content hash/size;
 * `fileId` (oc:fileid) is stable across MOVE and identifies the collection for
 * rename detection. Surfaced separately from files so empty-directory pruning can
 * derive "which collections hold no descendant file" from a full listing.
 */
export interface RemoteDirInfo {
  path: string;
  fileId: string | null;
  etag: string | null;
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
  /**
   * Start time (epoch ms) of the sync run that produced this entry — the run's `summary.startedAt`
   * for a full sync, or the op's own time for a watch-mode single-file op. Used to group the Sync
   * Status dialog's recent activity by sync run. Optional for backward compatibility: entries
   * recorded before this field existed are grouped by their own `at` (best-effort).
   */
  runStartedAt?: number;
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
/**
 * An `If-Match` / `If-None-Match` precondition failed (HTTP 412): the remote file changed since the
 * validator (etag) we sent, so the upload was refused to prevent a lost update. The engine converts
 * this into a conflict (download remote + resolve) instead of overwriting.
 */
export class PreconditionFailedError extends Error {
  constructor(public readonly path: string) {
    super(`Precondition failed (remote changed): ${path}`);
    this.name = 'PreconditionFailedError';
  }
}
