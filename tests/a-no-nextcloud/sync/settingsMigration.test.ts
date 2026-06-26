import { migrateBookmarksToConfigSync, pruneObsoleteSettings, resetDebugIdentityFields } from '../../../src/util/settingsMigration';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../../src/types';

function freshSettings(): DavSyncSettings {
  return { ...DEFAULT_SETTINGS, configSync: { ...DEFAULT_SETTINGS.configSync } };
}

// Feature 032: the Debug section no longer exposes a device name or a log folder. On every load both
// are forced back to the auto/fixed sentinel ('' ⇒ derived device name / vault-root logs), so every
// user converges onto one path regardless of what an older version persisted.
describe('[SPEC:DBG-3] resetDebugIdentityFields — converge device name / log folder to the fixed path', () => {
  it('[SPEC:DBG-3] resets a persisted custom device name and log folder to "" and reports dirty', () => {
    const settings = freshSettings();
    settings.deviceName = 'my-laptop';
    settings.logsFolder = 'Logs/system';
    const dirty = resetDebugIdentityFields({ deviceName: 'my-laptop', logsFolder: 'Logs/system' }, settings);
    expect(settings.deviceName).toBe('');
    expect(settings.logsFolder).toBe('');
    expect(dirty).toBe(true);
  });

  it('[SPEC:DBG-3] reports dirty when only one of the two had a custom value', () => {
    const a = freshSettings();
    expect(resetDebugIdentityFields({ deviceName: 'x', logsFolder: '' }, a)).toBe(true);
    expect(a.deviceName).toBe('');
    const b = freshSettings();
    expect(resetDebugIdentityFields({ deviceName: '', logsFolder: 'Logs' }, b)).toBe(true);
    expect(b.logsFolder).toBe('');
  });

  it('[SPEC:DBG-3] is a no-op (not dirty) on a clean profile with no saved values', () => {
    const settings = freshSettings();
    const dirty = resetDebugIdentityFields({}, settings);
    expect(settings.deviceName).toBe('');
    expect(settings.logsFolder).toBe('');
    expect(dirty).toBe(false);
  });

  it('[SPEC:DBG-3] forces "" even if the in-memory settings already carry a stale value', () => {
    const settings = freshSettings();
    settings.deviceName = 'stale';
    settings.logsFolder = 'stale/path';
    // saved had nothing → not dirty, but the live settings are still normalized to ''.
    const dirty = resetDebugIdentityFields({}, settings);
    expect(settings.deviceName).toBe('');
    expect(settings.logsFolder).toBe('');
    expect(dirty).toBe(false);
  });
});

// Feature 028 removed migrateLegacyDebugMode (the debug-log fields it migrated to no longer exist).
// The legacy `debugMode` key is still dropped by pruneObsoleteSettings (covered below).

describe('migrateBookmarksToConfigSync', () => {
  it('turns the master on with only Bookmarks when legacy syncBookmarks was true', () => {
    const settings = freshSettings();
    migrateBookmarksToConfigSync({ syncBookmarks: true }, settings);
    expect(settings.syncConfigFolder).toBe(true);
    expect(settings.configSync).toEqual({ bookmarks: true, others: false });
  });

  it('leaves the master off when legacy syncBookmarks was false', () => {
    const settings = freshSettings();
    settings.syncConfigFolder = false;
    migrateBookmarksToConfigSync({ syncBookmarks: false }, settings);
    expect(settings.syncConfigFolder).toBe(false);
  });

  it('leaves the master off when no legacy syncBookmarks key is present', () => {
    const settings = freshSettings();
    migrateBookmarksToConfigSync({}, settings);
    expect(settings.syncConfigFolder).toBe(false);
  });

  it('is idempotent: does nothing once syncConfigFolder has been persisted', () => {
    const settings = freshSettings();
    settings.syncConfigFolder = false;
    settings.configSync = { bookmarks: false, others: true };
    // Even though legacy syncBookmarks=true is present, the new flag already exists → no-op.
    migrateBookmarksToConfigSync({ syncBookmarks: true, syncConfigFolder: false }, settings);
    expect(settings.syncConfigFolder).toBe(false);
    expect(settings.configSync.bookmarks).toBe(false);
  });
});

describe('pruneObsoleteSettings', () => {
  it('drops a persisted legacy syncBookmarks key (no longer in the schema)', () => {
    const settings = { ...DEFAULT_SETTINGS, syncBookmarks: true } as unknown as Record<string, unknown>;
    const removed = pruneObsoleteSettings(settings);
    expect(removed).toContain('syncBookmarks');
    expect(settings.syncBookmarks).toBeUndefined();
  });

  it('removes keys not present in the current schema', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      // Leftovers from an earlier 0.3.0-beta / the removed debugMode field.
      debugMode: false,
      logLevel: 'verbose',
      syncResultsEnabled: true,
      syncResultsFolder: 'system/',
    } as unknown as Record<string, unknown>;
    const removed = pruneObsoleteSettings(settings);
    expect(removed.sort()).toEqual(['debugMode', 'logLevel', 'syncResultsEnabled', 'syncResultsFolder'].sort());
    expect(settings.debugMode).toBeUndefined();
    expect(settings.logLevel).toBeUndefined();
    expect(settings.syncResultsEnabled).toBeUndefined();
    expect(settings.syncResultsFolder).toBeUndefined();
  });

  it('keeps every valid schema key (including optional lastKnownServerVersion)', () => {
    const settings = { ...DEFAULT_SETTINGS } as unknown as Record<string, unknown>;
    const removed = pruneObsoleteSettings(settings);
    expect(removed).toEqual([]);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      expect(Object.prototype.hasOwnProperty.call(settings, key)).toBe(true);
    }
  });
});
