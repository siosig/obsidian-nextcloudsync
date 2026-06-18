import { DavSyncSettings } from '../types';

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
