// Shared type definitions for obsidian-nextcloudsync

export interface DavSyncSettings {
  serverUrl: string;
  username: string;
  /** stored via Obsidian Credentials API, not in data.json */
  syncFolder: string;
  syncIntervalMinutes: number;
  networkTimeoutSeconds: number;
  deviceId: string;
  uploadChunkThresholdMB: number;
  autoMergeEnabled: boolean;
  maxConflictRegions: number;
}

export const DEFAULT_SETTINGS: DavSyncSettings = {
  serverUrl: '',
  username: '',
  syncFolder: '',
  syncIntervalMinutes: 15,
  networkTimeoutSeconds: 30,
  deviceId: '',
  uploadChunkThresholdMB: 50,
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
