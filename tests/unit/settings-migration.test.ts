import { migrateLegacyDebugMode, pruneObsoleteSettings } from '../../src/util/settingsMigration';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../src/types';

function freshSettings(): DavSyncSettings {
  return { ...DEFAULT_SETTINGS };
}

describe('migrateLegacyDebugMode', () => {
  it('enables the debug log at level "debug" when legacy debugMode was true', () => {
    const settings = freshSettings();
    migrateLegacyDebugMode({ debugMode: true }, settings);
    expect(settings.debugLogEnabled).toBe(true);
    expect(settings.debugLogLevel).toBe('debug');
  });

  it('leaves defaults when legacy debugMode was false', () => {
    const settings = freshSettings();
    migrateLegacyDebugMode({ debugMode: false }, settings);
    expect(settings.debugLogEnabled).toBe(false);
    expect(settings.debugLogLevel).toBe('error');
  });

  it('leaves defaults when no legacy debugMode key is present', () => {
    const settings = freshSettings();
    migrateLegacyDebugMode({}, settings);
    expect(settings.debugLogEnabled).toBe(false);
    expect(settings.debugLogLevel).toBe('error');
  });

  it('does not override an already-saved debugLogEnabled value', () => {
    const settings = freshSettings();
    settings.debugLogEnabled = false;
    // User explicitly saved debugLogEnabled previously → legacy flag must not re-enable it.
    migrateLegacyDebugMode({ debugMode: true, debugLogEnabled: false }, settings);
    expect(settings.debugLogEnabled).toBe(false);
  });
});

describe('pruneObsoleteSettings', () => {
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
