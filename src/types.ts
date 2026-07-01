// Shared type definitions for nextcloud-sync

/**
 * Opt-in flags for `.obsidian` config-folder sync (issue #1). Each flag is only consulted when the
 * master `syncConfigFolder` setting is on. Community plugins and the plugin's own sync-state DB are
 * intentionally NOT representable here — they are permanent hard exclusions.
 *
 * Feature 029 collapsed the former five categories into two: Bookmarks stays on its own, and
 * everything else (appearance, themes & snippets, hotkeys, core-plugin settings) is grouped under
 * `others`. The detailed file mapping lives in `ConfigSyncResolver.CONFIG_SYNC_CATEGORIES`.
 */
export interface ConfigSyncCategories {
  /** bookmarks.json (migrated from the former standalone `syncBookmarks` setting) */
  bookmarks: boolean;
  /**
   * appearance.json / app.json, themes/** and snippets/**, hotkeys.json, and the core-plugin
   * config files (the fixed allowlist). Grouped from the former appearance/themesSnippets/
   * hotkeys/corePlugins categories (feature 029).
   */
  others: boolean;
}

/**
 * Conflict-resolution strategy for one file type (feature 037). A single per-type choice replaces the
 * former three conflict settings (autoMergeEnabled / conflictFailurePolicy / frontmatterConflictStrategy).
 *   merge        — 3-way merge: clean → merged, text conflict → markers, non-text → safe-hold (FR-005a)
 *   biggest-size — keep the larger side, overwrite the smaller (size tie → no-op success, FR-009)
 *   latest-mtime — keep the newer side, overwrite the older (mtime tie → no-op success, FR-009)
 *   local-win    — always keep the local side, overwrite remote
 *   remote-win   — always keep the remote side, overwrite local
 * `merge` is valid only for Auto Merge File types; Other File types use the four deterministic ones.
 */
export type SyncStrategy = 'merge' | 'biggest-size' | 'latest-mtime' | 'local-win' | 'remote-win';

/**
 * Policy for resolving a scalar frontmatter field that was changed to different values
 * on both local and remote sides.
 *   latest-mtime — file with the newer modification time wins; remote wins on tie
 *   remote-win   — remote value always wins
 *   local-win    — local value always wins
 * Experimental: may change or be removed in a future release.
 */
export type FrontmatterScalarPolicy = 'latest-mtime' | 'remote-win' | 'local-win';

/**
 * Runtime inputs for semantic frontmatter merge, threaded from ConflictContext.
 * Absent when no ConflictContext is available (e.g. unit tests); in that case
 * FrontmatterMergeStrategy falls back to 'remote-win' for scalar conflicts.
 */
export interface MergeContext {
  /** Scalar conflict resolution policy (from DavSyncSettings.frontmatterScalarConflictPolicy). */
  frontmatterScalarPolicy: FrontmatterScalarPolicy;
  /** Local file modification time in milliseconds since epoch. */
  localMtime: number;
  /** Remote file modification time in milliseconds since epoch. */
  remoteMtime: number;
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
  /** WebDAV request timeout in seconds. */
  networkTimeoutSeconds: number;
  deviceId: string;
  /** Absolute file-size cap (MB). Files exceeding this are skipped with a warning. 0 = unlimited. */
  maxFileSizeMB: number;
  /** Detect local Markdown edits and sync immediately (watch mode). Disabled on mobile. */
  watchOnChangeEnabled: boolean;
  /**
   * Startup sync delay in seconds, 0–10. 0 = no startup sync; 1–10 = wait that long after startup
   * before syncing. Default 1 (enabled). Folds the former `syncOnStartupEnabled` toggle (feature 034
   * rev): default ON on all platforms, mobile included (feature 030).
   */
  startupSyncDelaySeconds: number;
  /** Number of concurrent WebDAV requests. Derived from device RAM on first run if not persisted. */
  networkConcurrency: number;
  /**
   * Sync only on Wi-Fi (non-cellular). Not supported on iOS (no network-type API);
   * the toggle is disabled there and the setting is ignored.
   */
  syncOnWifiOnly: boolean;
  // Feature 033: chunkedUploadEnabled and fileLockingEnabled were removed (chunked upload is always
  // on, file locking always off). Both are now fixed in src/util/fixedSyncConfig.ts.
  /**
   * Use the Nextcloud bulk-upload endpoint to batch many small files into one request.
   * Default ON; only takes effect when the server advertises the capability.
   */
  bulkUploadEnabled: boolean;
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
  /** User-facing device label. Empty ⇒ derive "<platform>-<deviceId6>". Sanitized for filenames at use sites. */
  deviceName: string;
  /** Vault-relative folder holding both log files. Blank ⇒ vault root. */
  logsFolder: string;
  /** Master on/off for all log output (sync log + debug log). */
  loggingEnabled: boolean;
  // Feature 033: maxConflictRegions was removed (always unlimited; fixed in fixedSyncConfig.ts).
  /**
   * File extensions classified as "Auto Merge File" (feature 037; continues the role of the former
   * `mergeableExtensions`). Lowercase, no leading dot. A conflict on a file whose extension is in
   * this list is resolved with `autoMergeFileStrategy`; every other file (including extensionless
   * files) uses `otherFileStrategy`. An empty list routes ALL files through `otherFileStrategy`.
   */
  autoMergeFileTypes: string[];
  /**
   * Conflict strategy for Auto Merge File types (feature 037). Default `merge`. All five strategies
   * are valid here. When `merge`: clean 3-way → merged, text conflict → markers, non-text → safe-hold.
   */
  autoMergeFileStrategy: SyncStrategy;
  /**
   * Conflict strategy for every other file type (feature 037). Default `latest-mtime`. `merge` is not
   * offered here — only the four deterministic strategies (biggest-size / latest-mtime / local/remote-win).
   */
  otherFileStrategy: Exclude<SyncStrategy, 'merge'>;
  // Feature 033: explorerCompareEnabled was removed. The "Compare with remote" explorer menu item and
  // command are registered unconditionally in main.ts, so no setting gates them.
  /**
   * User-managed list of vault-relative folder paths that are never synced (feature 027).
   * Folder-prefix match at a folder boundary; entries are normalized and unique. This is an
   * additive layer on top of the permanent hard exclusions (dotfolders, community plugins,
   * the plugin's own state DB), which always apply regardless of this list.
   */
  excludedFolders: string[];
  /**
   * How to resolve a scalar frontmatter field when both sides changed it to different values.
   * Experimental — may change in a future release. Default: 'latest-mtime'.
   */
  frontmatterScalarConflictPolicy: FrontmatterScalarPolicy;
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
  networkTimeoutSeconds: 30,
  deviceId: '',
  maxFileSizeMB: 0, // 0 = unlimited (desktop default). Mobile gets a safe cap in loadSettings().
  watchOnChangeEnabled: true, // Mobile first-run: false (applied in loadSettings()).
  startupSyncDelaySeconds: 1, // 0 = no startup sync; default 1 = enabled with a 1 s delay.
  networkConcurrency: 16, // First-run: overridden by autoNetworkConcurrency() in loadSettings(); persisted value is kept on subsequent loads.
  // Desktop default OFF; mobile's first run flips it ON in loadSettings() (metered data).
  syncOnWifiOnly: false,
  bulkUploadEnabled: true,
  // Config-folder sync is opt-in: master defaults OFF, so a fresh install syncs notes only.
  // These category defaults take effect only once the user turns the master on.
  // Migrated `syncBookmarks: true` users get bookmarks-only instead
  // (see migrateBookmarksToConfigSync); `syncBookmarks` itself is removed and pruned.
  syncConfigFolder: false,
  configSync: {
    bookmarks: true,
    others: true,
  },
  deviceName: '',
  logsFolder: '',
  loggingEnabled: false,
  // Conflict strategies (feature 037): a single per-type choice. Defaults reproduce the prior felt
  // behaviour — Auto Merge File types attempt a 3-way merge, everything else takes the newer side.
  // Clearing autoMergeFileTypes routes every file through otherFileStrategy (no merge attempted).
  autoMergeFileTypes: ['md', 'txt', 'cpp', 'py', 'c', 'h', 'hpp', 'rs', 'go', 'ts', 'js', 'java', 'sh'],
  autoMergeFileStrategy: 'merge',
  otherFileStrategy: 'latest-mtime',
  excludedFolders: [],
  frontmatterScalarConflictPolicy: 'latest-mtime',
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
  /**
   * Feature 039 (FR-039-5): the merged output contains NESTED/stacked plugin conflict markers — the
   * fingerprint of marker re-entrancy that the upstream guard somehow missed. The caller must
   * safe-hold (write nothing, push nothing) instead of persisting the corrupt body. Optional/additive.
   */
  hold?: boolean;
}

/**
 * The action a ConflictResolver decides on for a conflicting file (feature 037). The decision is pure
 * (no I/O); SyncEngine.handleConflict executes the corresponding network/disk operations. Every
 * conflict is decided — there is no user-selectable "hold/error" strategy (FR-010).
 *   write         — write `content` locally (clean merge or marker-embedded text), then converge to server
 *   prefer-local  — overwrite the remote with the local copy
 *   prefer-remote — overwrite the local with the remote copy
 *   safe-hold     — non-text / unmergeable under `merge`: leave BOTH sides untouched and flag the file
 *                   conflicted, writing NO markers (binary-safe, FR-005a). Not an error; resolves on a
 *                   later sync once a side changes or the user resolves it.
 *   no-op         — deterministic-strategy tie (equal size for biggest-size / equal mtime for
 *                   latest-mtime): leave BOTH sides untouched, NOT conflicted, success (FR-009).
 *                   Re-evaluated on the next sync.
 */
export type ConflictResolution =
  | { action: 'write'; content: string; clean: boolean }
  | { action: 'prefer-local' }
  | { action: 'prefer-remote' }
  | { action: 'safe-hold' }
  | { action: 'no-op' };

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
