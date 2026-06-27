import { migrateBookmarksToConfigSync, migrateStartupToggleToDelay, pruneObsoleteSettings, resetDebugIdentityFields } from '../../../src/util/settingsMigration';
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

// Feature 034-rev: the "Sync on startup" toggle was folded into the startup-delay slider, where
// 0 = no startup sync (1–10 = delay seconds). migrateStartupToggleToDelay converts any persisted
// toggle state on load, before pruneObsoleteSettings drops the now-obsolete syncOnStartupEnabled key.
describe('[SPEC:SLD-7] migrateStartupToggleToDelay — fold the startup toggle into the delay slider', () => {
  it('startup OFF (toggle false) → delay becomes 0 (disabled)', () => {
    const settings = freshSettings();
    settings.startupSyncDelaySeconds = 1; // default carried over from DEFAULT_SETTINGS
    migrateStartupToggleToDelay({ syncOnStartupEnabled: false, startupSyncDelaySeconds: 1 }, settings);
    expect(settings.startupSyncDelaySeconds).toBe(0);
  });

  it('startup ON with old "immediate" (delay 0) → delay becomes 1 (kept enabled, smallest delay)', () => {
    const settings = freshSettings();
    settings.startupSyncDelaySeconds = 0;
    migrateStartupToggleToDelay({ syncOnStartupEnabled: true, startupSyncDelaySeconds: 0 }, settings);
    expect(settings.startupSyncDelaySeconds).toBe(1);
  });

  it('startup ON with a positive delay → the saved delay is preserved unchanged', () => {
    const settings = freshSettings();
    settings.startupSyncDelaySeconds = 7;
    migrateStartupToggleToDelay({ syncOnStartupEnabled: true, startupSyncDelaySeconds: 7 }, settings);
    expect(settings.startupSyncDelaySeconds).toBe(7);
  });

  it('is a no-op on the new model (no syncOnStartupEnabled saved): a deliberate delay 0 stays 0', () => {
    const settings = freshSettings();
    settings.startupSyncDelaySeconds = 0;
    migrateStartupToggleToDelay({ startupSyncDelaySeconds: 0 }, settings);
    expect(settings.startupSyncDelaySeconds).toBe(0);
  });

  it('pruneObsoleteSettings drops the obsolete syncOnStartupEnabled key (self-healing)', () => {
    const settings = { ...DEFAULT_SETTINGS, syncOnStartupEnabled: true } as unknown as Record<string, unknown>;
    const removed = pruneObsoleteSettings(settings);
    expect(removed).toContain('syncOnStartupEnabled');
    expect(settings.syncOnStartupEnabled).toBeUndefined();
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

// Feature 033: five low-value settings were removed from the schema. Their persisted values must not
// influence behavior (behavior reads the fixed config — see fixedSyncConfig.test.ts /
// uploadStrategySelection.test.ts) and the obsolete keys must be pruned on load (self-healing).
describe('[SPEC:FX-1] feature 033 — the five removed settings are pruned (self-healing)', () => {
  const REMOVED = [
    'explorerCompareEnabled',
    'fileLockingEnabled',
    'chunkedUploadEnabled',
    'uploadChunkThresholdMB',
    'maxConflictRegions',
  ] as const;

  it('drops each removed key, even when persisted at a non-default value', () => {
    const legacy: Record<string, unknown> = {
      ...DEFAULT_SETTINGS,
      explorerCompareEnabled: false,
      fileLockingEnabled: true,
      chunkedUploadEnabled: false,
      uploadChunkThresholdMB: 200,
      maxConflictRegions: 5,
    };
    const removed = pruneObsoleteSettings(legacy);
    for (const key of REMOVED) {
      expect(removed).toContain(key);
      expect(legacy[key]).toBeUndefined();
    }
  });

  it('is idempotent: a profile without the removed keys prunes nothing', () => {
    const clean = { ...DEFAULT_SETTINGS } as unknown as Record<string, unknown>;
    const removed = pruneObsoleteSettings(clean);
    for (const key of REMOVED) expect(removed).not.toContain(key);
  });
});
