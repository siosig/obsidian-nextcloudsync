import { applyMobileFirstRunDefaults } from '../../../src/util/settingsMigration';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../../src/types';

// Mobile first-run defaults (§15.3). loadSettings() calls applyMobileFirstRunDefaults only when
// Platform.isMobile; the function itself is platform-agnostic and only fills keys absent from the
// saved data.json, so an existing/user-set value survives (first-run only, forward-compatible).
describe('applyMobileFirstRunDefaults (§15.3)', () => {
  const freshSettings = (): DavSyncSettings => ({ ...DEFAULT_SETTINGS });

  describe('fresh install (no saved keys) → mobile-safe values are applied', () => {
    it('syncIntervalMinutes defaults to 0 on mobile (periodic sync never fires; disabled slider reads honestly)', () => {
      const s = freshSettings();
      applyMobileFirstRunDefaults({}, s);
      expect(s.syncIntervalMinutes).toBe(0);
    });
    it('syncOnWifiOnly defaults to true (cellular-cost-safe)', () => {
      const s = freshSettings();
      applyMobileFirstRunDefaults({}, s);
      expect(s.syncOnWifiOnly).toBe(true);
    });
    it('maxFileSizeMB defaults to 20 (OOM-safe cap)', () => {
      const s = freshSettings();
      applyMobileFirstRunDefaults({}, s);
      expect(s.maxFileSizeMB).toBe(20);
    });
    it('watchOnChangeEnabled defaults to false (no reliable change events, battery)', () => {
      const s = freshSettings();
      applyMobileFirstRunDefaults({}, s);
      expect(s.watchOnChangeEnabled).toBe(false);
    });
  });

  describe('existing user (key persisted) → saved value is preserved, never overwritten', () => {
    it('keeps a persisted syncIntervalMinutes on mobile (e.g. an older 15, or a deliberate 30)', () => {
      const s = freshSettings();
      s.syncIntervalMinutes = 30;
      applyMobileFirstRunDefaults({ syncIntervalMinutes: 30 }, s);
      expect(s.syncIntervalMinutes).toBe(30);
    });
    it('keeps a persisted syncIntervalMinutes of 15 (the pre-change default) rather than forcing 0', () => {
      const s = freshSettings();
      s.syncIntervalMinutes = 15;
      applyMobileFirstRunDefaults({ syncIntervalMinutes: 15 }, s);
      expect(s.syncIntervalMinutes).toBe(15);
    });
    it('keeps persisted values for the other three mobile keys', () => {
      const s = freshSettings();
      s.syncOnWifiOnly = false;
      s.maxFileSizeMB = 100;
      s.watchOnChangeEnabled = true;
      applyMobileFirstRunDefaults(
        { syncOnWifiOnly: false, maxFileSizeMB: 100, watchOnChangeEnabled: true },
        s,
      );
      expect(s.syncOnWifiOnly).toBe(false);
      expect(s.maxFileSizeMB).toBe(100);
      expect(s.watchOnChangeEnabled).toBe(true);
    });
  });

  it('mixed: fills only the absent keys, leaving persisted ones intact', () => {
    const s = freshSettings();
    s.maxFileSizeMB = 50; // persisted
    applyMobileFirstRunDefaults({ maxFileSizeMB: 50 }, s);
    expect(s.maxFileSizeMB).toBe(50);       // preserved
    expect(s.syncIntervalMinutes).toBe(0);  // filled
    expect(s.syncOnWifiOnly).toBe(true);    // filled
    expect(s.watchOnChangeEnabled).toBe(false); // filled
  });

  it('desktop default remains 15 (mobile override does not touch DEFAULT_SETTINGS)', () => {
    expect(DEFAULT_SETTINGS.syncIntervalMinutes).toBe(15);
  });
});
