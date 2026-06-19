import { DEFAULT_SETTINGS, DavSyncSettings } from '../types';

/**
 * Migrate the removed `debugMode` boolean to the new debug-log fields.
 *
 * When a previous version persisted `debugMode === true` and the new `debugLogEnabled` field
 * was never saved, enable the debug log at level `debug` so existing debuggers keep their log.
 * Mutates `settings` in place. No-op otherwise (fresh installs and already-migrated profiles).
 */
export function migrateLegacyDebugMode(
  saved: { debugMode?: unknown; debugLogEnabled?: unknown },
  settings: DavSyncSettings,
): void {
  if (saved.debugLogEnabled === undefined && saved.debugMode === true) {
    settings.debugLogEnabled = true;
    settings.debugLogLevel = 'debug';
  }
}

/**
 * Delete persisted settings keys that are no longer part of the schema (e.g. `debugMode`,
 * and the `logLevel` / `syncResultsEnabled` / `syncResultsFolder` fields left behind by an
 * earlier 0.3.0-beta implementation). Mutates `settings` in place and returns the removed keys.
 * Run after {@link migrateLegacyDebugMode} so any legacy value is migrated before it is dropped.
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
