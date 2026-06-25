import { Platform } from 'obsidian';
import { resolveConcurrencyDefault } from './limits';

// Platform-derived defaults for settings whose user-facing toggle was removed in the
// settings-simplification (feature 028). These are computed from `Platform` on every read and
// never persisted to data.json — there is a single path and the platform decides. Values match
// the former first-run mobile overrides in loadSettings(), so behaviour is unchanged.

/**
 * Absolute file-size cap (MB). Desktop: 0 (unlimited). Mobile: 20 — an OOM-safe cap, since the
 * mobile WebView holds the whole file in memory during transfer.
 */
export function autoMaxFileSizeMB(): number {
  return Platform.isMobile ? 20 : 0;
}

/**
 * Sync once on startup. Always true on every platform (feature 030): a single sync when the app
 * opens keeps both devices current without relying on background timing. Mobile users explicitly
 * asked for startup sync to default ON.
 */
export function autoSyncOnStartup(): boolean {
  return true;
}

/**
 * Watch local edits and sync immediately (watch mode). Desktop: true. Mobile: false — the mobile
 * platform does not deliver reliable file-change events and continuous syncing drains battery.
 */
export function autoWatchOnChange(): boolean {
  return !Platform.isMobile;
}

/**
 * Number of concurrent WebDAV requests, derived from device RAM on every platform (no Platform
 * branch; mobile simply tends to report no `deviceMemory` → a conservative value). Sync of many
 * small files is round-trip bound, so concurrency scales with available memory.
 */
export function autoNetworkConcurrency(): number {
  const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return resolveConcurrencyDefault(deviceMemoryGB);
}
