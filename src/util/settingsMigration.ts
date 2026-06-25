import { DEFAULT_SETTINGS, DavSyncSettings } from '../types';

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
    settings.configSync = {
      appearance: false,
      themesSnippets: false,
      hotkeys: false,
      corePlugins: false,
      bookmarks: true,
    };
  }
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
