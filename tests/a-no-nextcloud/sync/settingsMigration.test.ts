import { migrateBookmarksToConfigSync, pruneObsoleteSettings } from '../../../src/util/settingsMigration';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../../src/types';

function freshSettings(): DavSyncSettings {
  return { ...DEFAULT_SETTINGS, configSync: { ...DEFAULT_SETTINGS.configSync } };
}

// Feature 028 removed migrateLegacyDebugMode (the debug-log fields it migrated to no longer exist).
// The legacy `debugMode` key is still dropped by pruneObsoleteSettings (covered below).

describe('migrateBookmarksToConfigSync', () => {
  it('turns the master on with only Bookmarks when legacy syncBookmarks was true', () => {
    const settings = freshSettings();
    migrateBookmarksToConfigSync({ syncBookmarks: true }, settings);
    expect(settings.syncConfigFolder).toBe(true);
    expect(settings.configSync).toEqual({
      appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: true,
    });
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
    settings.configSync = { appearance: true, themesSnippets: true, hotkeys: true, corePlugins: true, bookmarks: false };
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
