import { DEFAULT_SETTINGS, DavSyncSettings } from '../types';

/**
 * Migrate the former five-key configSync ({appearance, themesSnippets, hotkeys, corePlugins,
 * bookmarks}) into the two-key model ({bookmarks, others}) introduced in feature 029. The four
 * non-bookmark categories collapse into `others` (enabled if ANY of them was enabled). A profile
 * already on the two-key shape (has an `others` key) is normalized to booleans. Mutates `settings`.
 * Run before {@link migrateBookmarksToConfigSync} (which handles the even older `syncBookmarks`).
 */
export function migrateConfigSyncCategories(
  saved: { configSync?: unknown },
  settings: DavSyncSettings,
): void {
  const sc = saved.configSync;
  if (!sc || typeof sc !== 'object') return; // nothing persisted → keep defaults
  const obj = sc as Record<string, unknown>;
  if ('others' in obj) {
    settings.configSync = { bookmarks: Boolean(obj.bookmarks), others: Boolean(obj.others) };
    return;
  }
  settings.configSync = {
    bookmarks: Boolean(obj.bookmarks),
    others: Boolean(obj.appearance) || Boolean(obj.themesSnippets) || Boolean(obj.hotkeys) || Boolean(obj.corePlugins),
  };
}

/**
 * Migrate the removed standalone `syncBookmarks` boolean into the new config-folder sync model.
 *
 * Runs once on first upgrade (detected by the new master flag never having been persisted):
 *   - `syncBookmarks === true`  → turn the master ON with ONLY the Bookmarks category enabled,
 *     so bookmarks keep syncing and nothing else under the config folder starts syncing.
 *   - `syncBookmarks` false/absent → leave the master OFF (default); nothing migrates.
 *
 * Idempotent: once `syncConfigFolder` has been persisted, this is a no-op. Mutates `settings`.
 * Run before {@link pruneObsoleteSettings} so the now-obsolete `syncBookmarks` key is then dropped.
 */
export function migrateBookmarksToConfigSync(
  saved: { syncBookmarks?: unknown; syncConfigFolder?: unknown },
  settings: DavSyncSettings,
): void {
  if (saved.syncConfigFolder !== undefined) return; // already on the new model — don't re-migrate
  if (saved.syncBookmarks === true) {
    settings.syncConfigFolder = true;
    settings.configSync = { bookmarks: true, others: false };
  }
}

/**
 * Force the two Debug-identity fields back to their auto/fixed sentinels (feature 032). The settings
 * UI no longer lets the user set a device name or a log folder; every user converges onto the single
 * path where the device name is derived (`deviceName=''` ⇒ `<platform>-<deviceId>`) and logs are
 * written to the vault root (`logsFolder=''`). This runs unconditionally on every load, so a value
 * persisted by an older version is overwritten. Returns true when a non-empty value was present in
 * the saved data (so the caller can persist the cleanup). Mutates `settings` in place.
 */
export function resetDebugIdentityFields(
  saved: { deviceName?: unknown; logsFolder?: unknown },
  settings: DavSyncSettings,
): boolean {
  const hadCustom =
    (typeof saved.deviceName === 'string' && saved.deviceName.length > 0) ||
    (typeof saved.logsFolder === 'string' && saved.logsFolder.length > 0);
  settings.deviceName = '';
  settings.logsFolder = '';
  return hadCustom;
}

/**
 * Delete persisted settings keys that are no longer part of the schema (e.g. `debugMode`,
 * and the `logLevel` / `syncResultsEnabled` / `syncResultsFolder` fields left behind by an
 * earlier 0.3.0-beta implementation). Mutates `settings` in place and returns the removed keys.
 * The legacy `debugMode` key and the settings removed by feature 028 are simply dropped here.
 */
export function pruneObsoleteSettings(settings: Record<string, unknown>): string[] {
  const allowed = new Set<string>(Object.keys(DEFAULT_SETTINGS));
  const removed: string[] = [];
  for (const key of Object.keys(settings)) {
    if (!allowed.has(key)) {
      delete settings[key];
      removed.push(key);
    }
  }
  return removed;
}
