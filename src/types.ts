// Shared type definitions for obsidian-nextcloudsync

export interface DavSyncSettings {
  serverUrl: string;
  username: string;
  /**
   * Obsidian SecretStorage に保存したアプリパスワードの参照 ID。
   * 実際のパスワード値は data.json には保存されず、secretStorage が暗号化管理する。
   */
  passwordSecretId: string;
  syncIntervalMinutes: number;
  networkTimeoutSeconds: number;
  deviceId: string;
  /**
   * このサイズ（MB）を超えるファイルはチャンク分割アップロードを開始する閾値。
   * （旧仕様の「超過でスキップ」から「チャンク化開始」に意味変更。002 仕様）
   */
  uploadChunkThresholdMB: number;
  /** 絶対上限（MB）。これを超えるファイルのみスキップ＋警告する。 */
  maxFileSizeMB: number;
  /** チャンク分割アップロードを有効化する（既定 ON・Nextcloud のみ作動）。 */
  chunkedUploadEnabled: boolean;
  /** Files Locking を有効化する（実験的・既定 OFF・files_lock 対応サーバーのみ作動）。 */
  fileLockingEnabled: boolean;
  autoMergeEnabled: boolean;
  maxConflictRegions: number;
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
  chunkedUploadEnabled: true,
  fileLockingEnabled: false,
  autoMergeEnabled: false,
  maxConflictRegions: 3,
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
  conflictCount: number;
  errorCount: number;
  retriedFiles: string[];
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'conflict';

// ── US1: Login Flow v2 ──────────────────────────────────────────────────────

/** Login Flow v2 開始レスポンス（POST /index.php/login/v2）。 */
export interface LoginFlowInit {
  /** ポーリングに使うトークン。 */
  pollToken: string;
  /** ポーリング先の絶対 URL。 */
  pollEndpoint: string;
  /** ブラウザで開くログイン承認 URL。 */
  loginUrl: string;
}

/** Login Flow v2 ポーリング結果（判別付きユニオン）。 */
export type LoginFlowResult =
  | { status: 'success'; server: string; loginName: string; appPassword: string }
  | { status: 'pending' }
  | { status: 'timeout' }
  | { status: 'unsupported' };

// ── US2: File Versions ──────────────────────────────────────────────────────

/** サーバーが保持する1ファイルの過去バージョン。 */
export interface FileVersion {
  /** versions/{fileId}/{versionId} の末尾識別子。 */
  versionId: string;
  /** GET/MOVE に使うリモートパス（files ルートとは別の versions 名前空間）。 */
  href: string;
  /** 最終更新（エポックミリ秒）。 */
  lastModified: number;
  /** バイトサイズ。 */
  size: number;
}

// ── US3: Chunked Upload（実装内部）──────────────────────────────────────────

/** チャンクアップロードの進行状態。 */
export interface ChunkUploadSession {
  uploadId: string;
  remotePath: string;
  totalBytes: number;
  chunkSizeBytes: number;
}

// ── US4: Files Locking（実装内部）───────────────────────────────────────────

/** 取得中のサーバーロック。 */
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
export class UnsupportedVersionError extends Error {
  constructor(public readonly detectedVersion: string) {
    super(`Unsupported Nextcloud version: ${detectedVersion}`); this.name = 'UnsupportedVersionError';
  }
}
export class CredentialsNotFoundError extends Error {
  constructor() { super('App password not found in credentials'); this.name = 'CredentialsNotFoundError'; }
}
/** Nextcloud 固有機能が非対応クライアント（標準 WebDAV）で呼ばれた。 */
export class FeatureUnsupportedError extends Error {
  constructor(public readonly feature: string) {
    super(`Feature not supported on this server: ${feature}`);
    this.name = 'FeatureUnsupportedError';
  }
}
/** Login Flow v2 の開始・ポーリングに失敗した。 */
export class LoginFlowError extends Error {
  constructor(public readonly reason: string) {
    super(`Login Flow failed: ${reason}`);
    this.name = 'LoginFlowError';
  }
}
/** 対象ファイルが他クライアントにロックされている（HTTP 423）。 */
export class FileLockedError extends Error {
  constructor(public readonly path: string) {
    super(`File is locked: ${path}`);
    this.name = 'FileLockedError';
  }
}
