import { DEFAULT_SETTINGS } from '../../../src/types';
import { hostToken } from '../../../src/util/hostToken';
import { debugLogPath } from '../../../src/util/logPaths';

// Five settings (fileLocking, chunkedUpload, chunkThreshold, maxConflictRegions, explorerCompare) live in
// src/util/fixedSyncConfig.ts (see fixedSyncConfig.test.ts); the defaults asserted here are the ones that
// remain user-editable.
describe('DEFAULT_SETTINGS — remaining default contract (C2)', () => {
  it('matches the settings contract (C2)', () => {
    expect(DEFAULT_SETTINGS.startupSyncDelaySeconds).toBe(1);
    expect(DEFAULT_SETTINGS.networkTimeoutSeconds).toBe(30);
    expect(DEFAULT_SETTINGS.autoMergeFileStrategy).toBe('merge');
    expect(DEFAULT_SETTINGS.otherFileStrategy).toBe('latest-mtime');
    expect(DEFAULT_SETTINGS.logsFolder).toBe('');
    expect(DEFAULT_SETTINGS.deviceName).toBe('');
  });
});

// With the Device name / Log folder inputs gone, the fixed values must derive the device token and
// vault-root log paths from the empty sentinels, with no user input.
describe('[SPEC:DBG-2] fixed Debug identity: auto-derived device name + vault-root logs', () => {
  const deviceId = 'a1b2c3d4-5e6f-7890-abcd-ef1234567890';

  it('[SPEC:DBG-2] the empty deviceName default derives "<platform>-<deviceId6>"', () => {
    expect(DEFAULT_SETTINGS.deviceName).toBe('');
    expect(hostToken(DEFAULT_SETTINGS.deviceName, 'desktop', deviceId)).toBe('desktop-a1b2c3');
    expect(hostToken(DEFAULT_SETTINGS.deviceName, 'ios', deviceId)).toBe('ios-a1b2c3');
  });

  it('[SPEC:DBG-2] the empty logsFolder default puts the log at the vault root', () => {
    expect(DEFAULT_SETTINGS.logsFolder).toBe('');
    const host = 'desktop-a1b2c3';
    expect(debugLogPath(DEFAULT_SETTINGS.logsFolder, host)).toBe('nextcloud-debug_desktop-a1b2c3.txt');
  });
});
