import { DEFAULT_SETTINGS } from '../../../src/types';
import { hostToken } from '../../../src/util/hostToken';
import { syncLogPath, debugLogPath } from '../../../src/util/logPaths';

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

// Feature 032: with the Device name / Log folder inputs removed, the fixed values must produce a
// derived device token and vault-root log paths from the empty sentinels — no user input involved.
describe('[SPEC:DBG-2] fixed Debug identity: auto-derived device name + vault-root logs', () => {
  const deviceId = 'a1b2c3d4-5e6f-7890-abcd-ef1234567890';

  it('[SPEC:DBG-2] the empty deviceName default derives "<platform>-<deviceId6>"', () => {
    expect(DEFAULT_SETTINGS.deviceName).toBe('');
    expect(hostToken(DEFAULT_SETTINGS.deviceName, 'desktop', deviceId)).toBe('desktop-a1b2c3');
    expect(hostToken(DEFAULT_SETTINGS.deviceName, 'ios', deviceId)).toBe('ios-a1b2c3');
  });

  it('[SPEC:DBG-2] the empty logsFolder default puts both logs at the vault root', () => {
    expect(DEFAULT_SETTINGS.logsFolder).toBe('');
    const host = 'desktop-a1b2c3';
    expect(syncLogPath(DEFAULT_SETTINGS.logsFolder, host)).toBe('nextcloud-sync_sync_desktop-a1b2c3.txt');
    expect(debugLogPath(DEFAULT_SETTINGS.logsFolder, host)).toBe('nextcloud-sync_debug_desktop-a1b2c3.txt');
  });
});
