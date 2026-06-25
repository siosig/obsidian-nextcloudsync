import { Platform } from 'obsidian';
import { autoMaxFileSizeMB, autoSyncOnStartup, autoWatchOnChange } from '../../../src/util/platformDefaults';

// Feature 028: platform-derived defaults must match the former first-run mobile overrides in
// loadSettings() (desktop = DEFAULT_SETTINGS, mobile = the OOM/battery-safe values).
describe('platform-derived defaults (028)', () => {
  afterEach(() => {
    Platform.isMobile = false; // restore default so other suites see desktop
  });

  describe('desktop (Platform.isMobile = false)', () => {
    beforeEach(() => { Platform.isMobile = false; });
    it('maxFileSize is unlimited (0)', () => expect(autoMaxFileSizeMB()).toBe(0));
    it('syncOnStartup is on', () => expect(autoSyncOnStartup()).toBe(true));
    it('watchOnChange is on', () => expect(autoWatchOnChange()).toBe(true));
  });

  describe('mobile (Platform.isMobile = true)', () => {
    beforeEach(() => { Platform.isMobile = true; });
    it('maxFileSize is capped at 20 MB (OOM-safe)', () => expect(autoMaxFileSizeMB()).toBe(20));
    it('syncOnStartup is off', () => expect(autoSyncOnStartup()).toBe(false));
    it('watchOnChange is off', () => expect(autoWatchOnChange()).toBe(false));
  });
});
