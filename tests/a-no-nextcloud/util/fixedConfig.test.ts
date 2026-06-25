import { FIXED } from '../../../src/sync/fixedConfig';

// Feature 028 (settings simplification): FIXED is the single source of truth for the values
// that were previously user-editable. These must match the former DEFAULT_SETTINGS so behaviour
// is unchanged — except explorerCompareEnabled, intentionally flipped to true (Q5).
describe('FIXED config constants (028)', () => {
  it('matches the settings contract (C2)', () => {
    expect(FIXED.fileLockingEnabled).toBe(false);
    expect(FIXED.startupSyncDelaySeconds).toBe(1);
    expect(FIXED.networkTimeoutSeconds).toBe(30);
    expect(FIXED.uploadChunkThresholdMB).toBe(50);
    expect(FIXED.chunkedUploadEnabled).toBe(true);
    expect(FIXED.bulkUploadEnabled).toBe(true);
    expect(FIXED.autoMergeEnabled).toBe(true);
    expect(FIXED.maxConflictRegions).toBe(0);
    // Feature 030: frontmatterConflictStrategy / mergeableExtensions / conflictFailurePolicy moved
    // back to DavSyncSettings (user-editable); their defaults are asserted in DEFAULT_SETTINGS tests.
    expect(FIXED.logsFolder).toBe('');
    expect(FIXED.deviceName).toBe('');
  });

  it('keeps the Compare-with-remote feature on (Q5: toggle removed, feature kept)', () => {
    expect(FIXED.explorerCompareEnabled).toBe(true);
  });
});
