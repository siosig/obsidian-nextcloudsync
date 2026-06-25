import { DEFAULT_SETTINGS } from '../../../src/types';

// Feature 032 (settings restoration): all values formerly in FIXED are now user-editable
// DavSyncSettings fields. Assert their defaults match the former FIXED values.
describe('DEFAULT_SETTINGS — formerly-fixed values (032)', () => {
  it('matches the former settings contract (C2)', () => {
    expect(DEFAULT_SETTINGS.fileLockingEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.startupSyncDelaySeconds).toBe(1);
    expect(DEFAULT_SETTINGS.networkTimeoutSeconds).toBe(30);
    expect(DEFAULT_SETTINGS.uploadChunkThresholdMB).toBe(50);
    expect(DEFAULT_SETTINGS.chunkedUploadEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.bulkUploadEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.autoMergeEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.maxConflictRegions).toBe(0);
    expect(DEFAULT_SETTINGS.logsFolder).toBe('');
    expect(DEFAULT_SETTINGS.deviceName).toBe('');
  });

  it('Compare-with-remote defaults OFF (user must opt in)', () => {
    expect(DEFAULT_SETTINGS.explorerCompareEnabled).toBe(false);
  });
});
