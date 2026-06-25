// Fixed configuration values for settings whose user-facing toggle was removed in the
// settings-simplification (feature 028). The plugin exposes a single, opinionated path:
// these constants are the single source of truth that replaces the removed DavSyncSettings
// fields. Every value matches the former DEFAULT_SETTINGS (so behaviour is unchanged for
// existing users), EXCEPT `explorerCompareEnabled`, which is now always on — the toggle is
// gone but the "Compare with remote" feature is kept (spec 028, Q5).
export const FIXED: {
  fileLockingEnabled: boolean;
  startupSyncDelaySeconds: number;
  networkTimeoutSeconds: number;
  uploadChunkThresholdMB: number;
  chunkedUploadEnabled: boolean;
  bulkUploadEnabled: boolean;
  autoMergeEnabled: boolean;
  maxConflictRegions: number;
  frontmatterConflictStrategy: 'local-wins' | 'remote-wins' | 'conflict';
  mergeableExtensions: string[];
  conflictFailurePolicy: 'error' | 'local-wins' | 'remote-wins' | 'conflict-markers';
  explorerCompareEnabled: boolean;
  logsFolder: string;
  deviceName: string;
} = {
  fileLockingEnabled: false,
  startupSyncDelaySeconds: 1,
  networkTimeoutSeconds: 30,
  uploadChunkThresholdMB: 50,
  chunkedUploadEnabled: true,
  bulkUploadEnabled: true,
  autoMergeEnabled: true,
  maxConflictRegions: 0,
  frontmatterConflictStrategy: 'conflict',
  mergeableExtensions: ['md', 'txt'],
  conflictFailurePolicy: 'error',
  explorerCompareEnabled: true, // Q5: feature kept, toggle removed
  logsFolder: '', // vault root
  deviceName: '', // derive '<platform>-<deviceId6>' at use sites
};
