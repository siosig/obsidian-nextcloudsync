/** Opt-in categories for config-folder sync; only consulted when `syncConfigFolder` is on (docs/spec.md §7). */
export interface ConfigSyncCategories {
  /** bookmarks.json. */
  bookmarks: boolean;
  /** Appearance, themes, snippets, hotkeys and core-plugin config; the file mapping is in `ConfigSyncResolver.CONFIG_SYNC_CATEGORIES`. */
  others: boolean;
}

/**
 * Conflict-resolution strategy for one file type (docs/spec.md §6.1).
 *   merge        — 3-way merge: clean → merged, text conflict → markers, non-text → safe-hold
 *   biggest-size — keep the larger side (size tie → no-op success)
 *   latest-mtime — keep the newer side (mtime tie → no-op success)
 *   local-win / remote-win — always keep that side, overwrite the other
 * `merge` is valid only for Auto Merge File types; Other File types use the four deterministic ones.
 */
export type SyncStrategy = 'merge' | 'biggest-size' | 'latest-mtime' | 'local-win' | 'remote-win';

/**
 * Second-level fallback for a part a primary `merge` could not auto-resolve (a body diff3 region or a
 * frontmatter scalar/object clash). Never reached by a primary strategy other than `merge`.
 *   conflict-markers — body keeps both sides as markers (flagged conflicted); frontmatter falls back to
 *                      latest-mtime; a binary body safe-holds.
 *   others           — resolve the part deterministically (a biggest-size tie falls to latest-mtime).
 */
export type ConflictStrategy = 'conflict-markers' | 'biggest-size' | 'latest-mtime' | 'local-win' | 'remote-win';

/** Runtime inputs for the merge. When absent, mtimes default to 0 (remote wins the tie) and `conflictStrategy` to 'conflict-markers'. */
export interface MergeContext {
  /** Local file modification time in milliseconds since epoch. */
  localMtime: number;
  /** Remote file modification time in milliseconds since epoch. */
  remoteMtime: number;
  /** How to resolve a part a primary `merge` could not auto-resolve. */
  conflictStrategy?: ConflictStrategy;
}

/**
 * The two clean versions of a note captured when a marker conflict is detected, before either side is
 * overwritten with markers, so force-resolution recovers a real clean version. Distinct from the merge
 * base, which holds one last-converged body.
 */
export interface CleanSideSnapshot {
  /** Clean local body. */
  local: string;
  /** Clean remote body. */
  remote: string;
  /** Local mtime at conflict time (ms). */
  localMtime: number;
  /** Remote lastModified at conflict time (ms). */
  remoteMtime: number;
  /** Clean local body size (bytes). */
  localSize: number;
  /** Clean remote body size (bytes). */
  remoteSize: number;
}

export interface DavSyncSettings {
  serverUrl: string;
  username: string;
  /** SecretStorage key of the app password; the password itself is never saved in data.json. */
  passwordSecretId: string;
  /** Auto-sync period in minutes. 0 = manual only. Disabled on mobile (the OS suspends timers). */
  syncIntervalMinutes: number;
  /** WebDAV request timeout in seconds. */
  networkTimeoutSeconds: number;
  deviceId: string;
  /** Absolute file-size cap (MB). Files exceeding this are skipped with a warning. 0 = unlimited. */
  maxFileSizeMB: number;
  /** Watch mode: sync local edits immediately. */
  watchOnChangeEnabled: boolean;
  /** Startup sync delay in seconds, 0-10; 0 = no startup sync. */
  startupSyncDelaySeconds: number;
  /** Number of concurrent WebDAV requests. Derived from device RAM on first run if not persisted. */
  networkConcurrency: number;
  /** Sync only on Wi-Fi; ignored on iOS (no network-type API). */
  syncOnWifiOnly: boolean;
  /**
   * Mass-delete circuit-breaker limit on absence-based local deletions per sync (docs/spec.md §8).
   * -1 = automatic max(20, 20% of tracked files); 0 = unlimited (risky); N > 0 = fixed limit.
   */
  massDeleteLimit: number;
  /** Master opt-in for syncing the Obsidian config folder; community plugins and this plugin's state DB are never synced. */
  syncConfigFolder: boolean;
  configSync: ConfigSyncCategories;
  /** Device label; empty derives `<platform>-<deviceId6>`. */
  deviceName: string;
  /** Vault-relative log folder; blank = vault root. */
  logsFolder: string;
  /** Master switch for log output. */
  loggingEnabled: boolean;
  /** "Auto Merge File" extensions, lowercase without dot; every other file uses `otherFileStrategy` (an empty list routes all files there). */
  autoMergeFileTypes: string[];
  /** Conflict strategy for Auto Merge File types; all five are valid. */
  autoMergeFileStrategy: SyncStrategy;
  /** Conflict strategy for every other file type; `merge` is not offered. */
  otherFileStrategy: Exclude<SyncStrategy, 'merge'>;
  /** Vault-relative folders that are never synced (folder-boundary prefix match); the permanent hard exclusions apply regardless. */
  excludedFolders: string[];
  /**
   * Conflict strategy for a markdown file's frontmatter block, independent of the body. `merge` is a
   * semantic merge (arrays set-merged, scalars tie-broken by latest-mtime); the others adopt one whole side.
   */
  frontmatterStrategy: SyncStrategy;
  /** Fallback for a part a primary `merge` could not resolve; inert for a deterministic primary strategy. */
  conflictStrategy: ConflictStrategy;
  /** Checked Sync Status filter keys; absent = all shown. Unknown keys are ignored on load. */
  statusFilter?: SyncFileOp[];
  /** Last server version seen at connect time; drives the upgrade-recommendation banner. */
  lastKnownServerVersion?: string;
}

export const DEFAULT_SETTINGS: DavSyncSettings = {
  serverUrl: '',
  username: '',
  passwordSecretId: '',
  syncIntervalMinutes: 15,
  networkTimeoutSeconds: 30,
  deviceId: '',
  maxFileSizeMB: 0, // desktop default; mobile gets a cap in loadSettings()
  watchOnChangeEnabled: true,
  startupSyncDelaySeconds: 1,
  networkConcurrency: 16, // overridden on first run by autoNetworkConcurrency()
  // Mobile's first run flips this ON (metered data).
  syncOnWifiOnly: false,
  massDeleteLimit: -1,
  // Master OFF: a fresh install syncs notes only. Category defaults apply once the master is on.
  syncConfigFolder: false,
  configSync: {
    bookmarks: true,
    others: true,
  },
  deviceName: '',
  logsFolder: '',
  loggingEnabled: false,
  // `md` is not listed: markdown is always special-cased (frontmatter -> frontmatterStrategy, body ->
  // autoMergeFileStrategy), so this list only classifies non-markdown text.
  autoMergeFileTypes: ['txt', 'cpp', 'py', 'c', 'h', 'hpp', 'rs', 'go', 'ts', 'js', 'java', 'sh'],
  autoMergeFileStrategy: 'merge',
  otherFileStrategy: 'latest-mtime',
  excludedFolders: [],
  frontmatterStrategy: 'merge',
  conflictStrategy: 'conflict-markers',
  // Explicit `undefined` keeps the key in pruneObsoleteSettings' allowlist, so a saved selection is never pruned.
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
   * Local mtime re-statted right after the plugin's own write/download: the change-detection fast-path
   * key on mobile, where `setMtime()` is a no-op. Absent in older state files, which cost one
   * reconciling hash (docs/spec.md §4.2).
   */
  localMtime?: number;
  /** Local size observed with `localMtime`. */
  localSize?: number;
  /** Server `lastModified` at the last converged state, separate from `localMtime`. */
  remoteMtime?: number;
}

/** A tracked directory; `remoteFileId` (oc:fileid) is stable across MOVE for rename detection (docs/spec.md §8a.1). */
export interface DirState {
  path: string;
  remoteFileId: string | null;
}

export interface SyncState {
  deviceId: string;
  lastSyncTime: number;
  syncToken: string | null;
  files: Record<string, FileState>;
  /** Absent in older state files; treated as {}. */
  directories?: Record<string, DirState>;
  /**
   * Vault root ETag at the end of the last real full scan; a match lets the remote listing be rebuilt
   * from state instead of a Depth:infinity PROPFIND. Absent = next sync does a real scan (docs/spec.md §8a.5).
   */
  remoteRootEtag?: string | null;
  /** Consecutive short-circuited scans since the last real one (bounded by FORCE_FULL_SCAN_EVERY). */
  fullScanSkipCount?: number;
}

export interface NextcloudFeatures {
  isNextcloud: boolean;
  version: string;
  hasChecksums: boolean;
  hasFilesLocking: boolean;
  /** Bulk-upload endpoint `/remote.php/dav/bulk` is advertised or probed positive. */
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

/** A remote directory; `fileId` (oc:fileid) is stable across MOVE and identifies it for rename detection. */
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
  /** The output contains nested plugin conflict markers; the caller must safe-hold (write and push nothing). */
  hold?: boolean;
}

/**
 * The action ConflictResolver decides for a conflicting file; SyncEngine.handleConflict executes it
 * (docs/spec.md §6.2).
 *   write         — write `content` locally (clean merge or markers), then converge to the server
 *   prefer-local  — overwrite the remote with the local copy
 *   prefer-remote — overwrite the local with the remote copy
 *   safe-hold     — leave both sides untouched and flag the file conflicted, without markers; not an
 *                   error, resolves once a side changes or the user resolves it
 *   no-op         — deterministic-strategy tie: both sides untouched, not conflicted, success;
 *                   re-evaluated on the next sync
 */
export type ConflictResolution =
  | { action: 'write'; content: string; clean: boolean }
  | { action: 'prefer-local' }
  | { action: 'prefer-remote' }
  | { action: 'safe-hold' }
  | { action: 'no-op' };

/** One recorded sync error; `path` is empty for session-level errors. */
export interface SyncErrorDetail {
  path: string;
  message: string;
  /** Full list of skipped deletion candidates; set only when the file-side mass-delete breaker fires. */
  skippedPaths?: {
    all: string[];
  };
  /**
   * Full candidate paths split by category; set only when the directory mass-delete breaker fires
   * (exclusive with `skippedPaths`). The categories tell `SyncEngine.resolveAllSkippedDirs` which
   * primitive to apply per path.
   */
  dirBreakerSkipped?: {
    deleteRemote: string[];
    trashLocal: string[];
  };
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
  /** Start time (epoch ms) of the producing sync run, used to group recent activity; absent entries group by `at`. */
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

/** Read-only comparison of one file against its remote counterpart (SyncEngine.compareWithRemote); never mutates. */
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

export class SyncTokenExpiredError extends Error {
  constructor() { super('sync-token expired (HTTP 410)'); this.name = 'SyncTokenExpiredError'; }
}
export class ConflictError extends Error {
  constructor(public readonly path: string) {
    super(`Conflict at ${path}`); this.name = 'ConflictError';
  }
}
/**
 * A remote request that came back with an unusable status. `method` names the failed verb so the
 * message reads "HTTP 404 (GET)" (issue #25); the message keeps `HTTP <status>` as its prefix. The
 * response body is deliberately not in the message: it is server text that ends up in public logs.
 */
export class NetworkError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly method?: string,
  ) {
    super(method ? `HTTP ${status} (${method})` : `HTTP ${status}`);
    this.name = 'NetworkError';
  }
}
/**
 * The vault folder itself is absent from the server (Depth:infinity PROPFIND of the root returned
 * 404, issue #50). Unlike an empty listing it says nothing about individual files, so the engine
 * re-creates the folder and re-seeds from local instead of deleting. Extends NetworkError (404) so
 * existing `instanceof NetworkError` handling still applies.
 */
export class RemoteRootMissingError extends NetworkError {
  constructor() {
    super(404, '', 'PROPFIND');
    this.name = 'RemoteRootMissingError';
  }
}
/**
 * A 207 listing response whose body cannot be read as a listing (empty, truncated, a proxy's HTML
 * page, or XML that is not a multistatus; issue #51). Not an empty listing: that would make the scan
 * treat every tracked file as deleted, so this throws and the sync learns nothing. The message
 * carries the whole diagnostic (call, path, status, body length, reason, first characters) because
 * the clients have no logger.
 */
export class RemoteListingUnreadableError extends NetworkError {
  readonly op: string;
  readonly path: string;
  readonly bodyLength: number;
  readonly reason: string;
  readonly fragment: string;
  constructor(
    ctx: { op: string; path: string; status: number; method: 'PROPFIND' | 'REPORT' },
    xml: string,
    reason: string,
  ) {
    // `body` stays empty: this error reaches the Sync status dialog and debug log, where a huge
    // listing or proxy page does not belong.
    super(ctx.status, '', ctx.method);
    this.name = 'RemoteListingUnreadableError';
    this.op = ctx.op;
    this.path = ctx.path;
    this.reason = reason;
    this.bodyLength = new TextEncoder().encode(xml).length;
    this.fragment = xml.slice(0, 256).replace(/\s+/g, ' ').trim();
    this.message =
      `Remote listing unreadable: ${ctx.method} ${ctx.op} '${ctx.path}' → HTTP ${ctx.status}, ` +
      `${this.bodyLength} bytes, ${reason}; body starts: ${this.fragment}`;
  }
}
/**
 * A parent collection could not be created (PUT does not create parents, so ancestors are MKCOLed
 * first). Carries the folder and reason that a retried `HTTP 404 (PUT)` would hide. `dirPath` is the
 * ancestor that failed, not the file being written. Extends NetworkError so the file fails this sync
 * and is retried on the next.
 */
export class RemoteDirCreateError extends NetworkError {
  readonly dirPath: string;
  constructor(dirPath: string, status: number, detail?: string) {
    // `body` stays empty: the message reaches the Sync status dialog. `status` 0 = the request threw.
    super(status, '', 'MKCOL');
    this.name = 'RemoteDirCreateError';
    this.dirPath = dirPath;
    this.message =
      `Could not create the remote folder '${dirPath}': MKCOL ${status === 0 ? 'failed' : `→ HTTP ${status}`}` +
      (detail ? ` (${detail})` : '');
  }
}
/**
 * A PUT or DELETE returned 423 because another client or the server holds a lock on the path
 * (issue #58). Unlike `FileLockedError` (this plugin's own lock), the lock cannot be released here,
 * so the file is skipped this cycle and retried on the next. `lockOwner` comes from a best-effort
 * PROPFIND lockdiscovery read; when that fails a plain NetworkError is thrown instead
 * (docs/spec.md §6.5a). Extends NetworkError (423).
 */
export class ServerLockedError extends NetworkError {
  constructor(
    public readonly path: string,
    method: 'PUT' | 'DELETE',
    public readonly lockOwner: string | null,
  ) {
    super(423, '', method);
    this.name = 'ServerLockedError';
    this.message = this.lockOwner
      ? `HTTP 423 (${method}) — locked on the server by "${this.lockOwner}"`
      : `HTTP 423 (${method}) — locked on the server (owner unknown)`;
  }
}
/** Result of {@link IWebDAVClient.createVaultRoot}: MKCOL created the folder (201) or found it present (405). The distinction decides whether a re-seed may proceed. */
export type VaultRootOutcome = 'created' | 'exists';
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
/** An `If-Match` / `If-None-Match` precondition failed (HTTP 412): the upload was refused to prevent a lost update and the engine turns it into a conflict. */
export class PreconditionFailedError extends Error {
  constructor(public readonly path: string) {
    super(`Precondition failed (remote changed): ${path}`);
    this.name = 'PreconditionFailedError';
  }
}
