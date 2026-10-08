import { Platform } from 'obsidian';
import { resolveConcurrencyDefault } from './limits';

// Platform-derived values with no user-facing toggle: computed from `Platform` on every read and
// never persisted to data.json (docs/spec.md §15.3).

// Desktop 0 (unlimited); mobile 20 MB, since the WebView holds the whole file in memory.
export function autoMaxFileSizeMB(): number {
  return Platform.isMobile ? 20 : 0;
}

// True everywhere: one sync at app open keeps devices current without relying on background timing.
export function autoSyncOnStartup(): boolean {
  return true;
}

// Mobile is off: it does not deliver reliable file-change events and continuous syncing drains battery.
export function autoWatchOnChange(): boolean {
  return !Platform.isMobile;
}

// Derived from device RAM with no Platform branch: mobile tends to report no `deviceMemory`, which
// yields the conservative value.
export function autoNetworkConcurrency(): number {
  const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return resolveConcurrencyDefault(deviceMemoryGB);
}
