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
 * Fold the removed `syncOnStartupEnabled` toggle into the startup-delay slider, where 0 now means
 * "no startup sync" (1–10 = seconds to wait). Runs once on upgrade, detected by the old key still
 * being present in the saved data:
 *   - `syncOnStartupEnabled === false`          → startup sync was OFF  → set delay to 0 (off).
 *   - `syncOnStartupEnabled === true` & delay 0 → was "ON, run immediately"; 0 now means OFF, so
 *     bump to 1 to keep it enabled (the smallest enabled delay).
 *   - otherwise (ON with delay > 0)             → keep the saved delay unchanged.
 *
 * Idempotent: once `syncOnStartupEnabled` has been pruned from data.json (next save), this is a
 * no-op, so a user who deliberately sets delay 0 in the new model keeps it. Mutates `settings`.
 * Run before {@link pruneObsoleteSettings} so the now-obsolete `syncOnStartupEnabled` key is dropped.
 */
export function migrateStartupToggleToDelay(
  saved: { syncOnStartupEnabled?: unknown; startupSyncDelaySeconds?: unknown },
  settings: DavSyncSettings,
): void {
  if (saved.syncOnStartupEnabled === undefined) return; // already on the new model — don't re-migrate
  if (saved.syncOnStartupEnabled === false) {
    settings.startupSyncDelaySeconds = 0;
  } else if (saved.startupSyncDelaySeconds === 0) {
    settings.startupSyncDelaySeconds = 1;
  }
}

/**
 * Migrate the three removed conflict settings (autoMergeEnabled / conflictFailurePolicy /
 * frontmatterConflictStrategy + mergeableExtensions) into the feature 037 per-type strategy model
 * ({autoMergeFileTypes, autoMergeFileStrategy, otherFileStrategy}). Mapping (research R3):
 *   - autoMergeFileTypes  ← mergeableExtensions (role continues; values carried over verbatim)
 *   - autoMergeFileStrategy ← autoMergeEnabled=true → 'merge'; =false → conflictFailurePolicy
 *       (local-wins→local-win / remote-wins→remote-win / conflict-markers|error → 'merge', since the
 *        new model has no hold/error and Merge still surfaces markers for manual resolution)
 *   - otherFileStrategy   ← conflictFailurePolicy (local-wins→local-win / remote-wins→remote-win /
 *        conflict-markers|error|absent → 'latest-mtime', the default; Other File has no merge/markers)
 *   - frontmatterConflictStrategy → discarded (Merge marks diverging frontmatter as a conflict, FR-005)
 *
 * Idempotent: once `autoMergeFileStrategy` has been persisted (next save), this is a no-op, so a
 * deliberate new-model choice is never overwritten. A profile with none of the old keys is a fresh
 * install and keeps DEFAULT_SETTINGS. Mutates `settings`; run before {@link pruneObsoleteSettings}.
 */
export function migrateConflictSettingsToStrategies(
  saved: {
    autoMergeEnabled?: unknown;
    conflictFailurePolicy?: unknown;
    mergeableExtensions?: unknown;
    autoMergeFileStrategy?: unknown;
  },
  settings: DavSyncSettings,
): void {
  if (saved.autoMergeFileStrategy !== undefined) return; // already on the new model
  const hasOld =
    saved.autoMergeEnabled !== undefined ||
    saved.conflictFailurePolicy !== undefined ||
    saved.mergeableExtensions !== undefined;
  if (!hasOld) return; // fresh install → keep DEFAULT_SETTINGS

  if (Array.isArray(saved.mergeableExtensions)) {
    settings.autoMergeFileTypes = saved.mergeableExtensions.filter(
      (e): e is string => typeof e === 'string',
    );
  }
  const policy = saved.conflictFailurePolicy;
  settings.autoMergeFileStrategy =
    saved.autoMergeEnabled === false
      ? policy === 'local-wins'
        ? 'local-win'
        : policy === 'remote-wins'
          ? 'remote-win'
          : 'merge'
      : 'merge';
  settings.otherFileStrategy =
    policy === 'local-wins'
      ? 'local-win'
      : policy === 'remote-wins'
        ? 'remote-win'
        : 'latest-mtime';
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
 * Mobile-only first-run defaults. `loadSettings()` calls this only when `Platform.isMobile`, and it
 * touches a key only when that key is absent from the saved data.json — so an existing/user-set value
 * is preserved (first-run only, forward-compatible). Pure and platform-agnostic (the caller decides
 * whether the device is mobile), which keeps it unit-testable without a `Platform` mock. Mobile
 * diverges from `DEFAULT_SETTINGS` (desktop values) on the keys the mobile platform makes unsafe or
 * inert:
 *   - `syncOnWifiOnly`      = `true`  — cellular-cost-safe default (iOS lacks the API, so effectively
 *                                        inert there, but Android honours it).
 *   - `maxFileSizeMB`       = `20`    — OOM-safe cap; the mobile WebView holds the whole file in memory.
 *   - `watchOnChangeEnabled`= `false` — mobile delivers no reliable file-change events and continuous
 *                                        syncing drains battery.
 *   - `syncIntervalMinutes` = `0`     — the mobile OS suspends background timers, so periodic sync never
 *                                        fires (see the `!Platform.isMobile` guard in
 *                                        `applyAutoSyncInterval`); defaulting to 0 (= manual only) makes
 *                                        the disabled "Sync interval" slider read honestly instead of
 *                                        showing an inert 15.
 * Mutates `settings` in place. Run before {@link pruneObsoleteSettings} so the values are persisted.
 */
export function applyMobileFirstRunDefaults(
  saved: {
    syncOnWifiOnly?: unknown;
    maxFileSizeMB?: unknown;
    watchOnChangeEnabled?: unknown;
    syncIntervalMinutes?: unknown;
  },
  settings: DavSyncSettings,
): void {
  if (saved.syncOnWifiOnly === undefined) settings.syncOnWifiOnly = true;
  if (saved.maxFileSizeMB === undefined) settings.maxFileSizeMB = 20;
  if (saved.watchOnChangeEnabled === undefined) settings.watchOnChangeEnabled = false;
  if (saved.syncIntervalMinutes === undefined) settings.syncIntervalMinutes = 0;
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
