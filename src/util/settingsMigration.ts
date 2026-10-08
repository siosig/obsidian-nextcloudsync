import { DEFAULT_SETTINGS, DavSyncSettings } from '../types';

// Five-key configSync {appearance, themesSnippets, hotkeys, corePlugins, bookmarks} -> {bookmarks, others};
// `others` is on if ANY of the four collapsed categories was. Run before migrateBookmarksToConfigSync.
export function migrateConfigSyncCategories(
  saved: { configSync?: unknown },
  settings: DavSyncSettings,
): void {
  const sc = saved.configSync;
  if (!sc || typeof sc !== 'object') return;
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

// `syncBookmarks === true` turns the master ON with ONLY Bookmarks enabled, so bookmarks keep syncing
// and nothing else under the config folder starts. Idempotent once `syncConfigFolder` is persisted.
// Run before pruneObsoleteSettings.
export function migrateBookmarksToConfigSync(
  saved: { syncBookmarks?: unknown; syncConfigFolder?: unknown },
  settings: DavSyncSettings,
): void {
  if (saved.syncConfigFolder !== undefined) return;
  if (saved.syncBookmarks === true) {
    settings.syncConfigFolder = true;
    settings.configSync = { bookmarks: true, others: false };
  }
}

// Folds `syncOnStartupEnabled` into the startup-delay slider, where 0 means "no startup sync":
// OFF -> 0; ON with delay 0 ("run immediately") -> 1 to stay enabled; otherwise unchanged.
// Idempotent once the old key is pruned. Run before pruneObsoleteSettings.
export function migrateStartupToggleToDelay(
  saved: { syncOnStartupEnabled?: unknown; startupSyncDelaySeconds?: unknown },
  settings: DavSyncSettings,
): void {
  if (saved.syncOnStartupEnabled === undefined) return;
  if (saved.syncOnStartupEnabled === false) {
    settings.startupSyncDelaySeconds = 0;
  } else if (saved.startupSyncDelaySeconds === 0) {
    settings.startupSyncDelaySeconds = 1;
  }
}

// Old conflict settings -> per-type strategies:
//  - autoMergeFileTypes <- mergeableExtensions (verbatim)
//  - autoMergeFileStrategy <- autoMergeEnabled=true: 'merge'; false: conflictFailurePolicy
//    (local-wins/remote-wins map across; conflict-markers|error -> 'merge', which still surfaces markers)
//  - otherFileStrategy <- conflictFailurePolicy (local-wins/remote-wins map across; else 'latest-mtime')
//  - frontmatterConflictStrategy is discarded (Merge marks diverging frontmatter as a conflict)
// Idempotent once `autoMergeFileStrategy` is persisted; a profile with no old keys keeps DEFAULT_SETTINGS.
// Run before pruneObsoleteSettings.
export function migrateConflictSettingsToStrategies(
  saved: {
    autoMergeEnabled?: unknown;
    conflictFailurePolicy?: unknown;
    mergeableExtensions?: unknown;
    autoMergeFileStrategy?: unknown;
  },
  settings: DavSyncSettings,
): void {
  if (saved.autoMergeFileStrategy !== undefined) return;
  const hasOld =
    saved.autoMergeEnabled !== undefined ||
    saved.conflictFailurePolicy !== undefined ||
    saved.mergeableExtensions !== undefined;
  if (!hasOld) return;

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

// Not a same-named value mapping: the old policy only tuned the scalar tiebreak inside a merge that
// always ran (arrays always set-merged). Mapping it to the same-named whole-side strategy would
// silently drop array union-merge, so every migrating user converges to `merge`.
// Idempotent once `frontmatterStrategy` is saved. Run before pruneObsoleteSettings.
export function migrateFrontmatterScalarPolicyToStrategy(
  saved: { frontmatterStrategy?: unknown; frontmatterScalarConflictPolicy?: unknown },
  settings: DavSyncSettings,
): void {
  if (saved.frontmatterStrategy !== undefined) return;
  if (saved.frontmatterScalarConflictPolicy !== undefined) {
    settings.frontmatterStrategy = 'merge';
  }
}

// Markdown is always special-cased (frontmatter -> frontmatterStrategy, body -> autoMergeFileStrategy),
// so `md` must not sit in `autoMergeFileTypes`; strip it from any persisted list. Idempotent.
// Run before pruneObsoleteSettings.
export function migrateMarkdownAutoMergeType(settings: DavSyncSettings): void {
  settings.autoMergeFileTypes = (settings.autoMergeFileTypes ?? []).filter(
    (e) => typeof e === 'string' && e.trim().replace(/^\.+/, '').toLowerCase() !== 'md',
  );
}

// The UI no longer sets these: the device name is derived (`deviceName=''` -> `<platform>-<deviceId>`)
// and logs go to the vault root. Runs on every load, overwriting older persisted values. Returns true
// when a non-empty value was present so the caller can persist the cleanup.
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

// Mobile first-run defaults; the caller decides whether the device is mobile. A key is touched only
// when absent from the saved data, so user-set values are preserved.
//  - syncOnWifiOnly = true: cellular-cost-safe (inert on iOS, which lacks the API; Android honours it).
//  - maxFileSizeMB = 20: OOM-safe, the WebView holds the whole file in memory.
//  - watchOnChangeEnabled = false: opt-in; watch mode runs only in the foreground and costs battery/data.
//  - syncIntervalMinutes = 0: the OS suspends background timers (see applyAutoSyncInterval), so the
//    disabled slider reads honestly instead of showing an inert 15.
// Run before pruneObsoleteSettings so the values are persisted.
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

// Drops persisted keys that are no longer in DEFAULT_SETTINGS and returns the removed keys.
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
