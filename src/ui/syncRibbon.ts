import type { IconName } from 'obsidian';

// Mobile draws no ribbon bar (`.side-dock-ribbon` is display: none), but Obsidian republishes every registered
// ribbon action in the navigation bar's "Open menu", so one addRibbonIcon call gives a two-tap mobile sync and a
// one-click desktop sync. The menu builds its entries on tap, so probing the hidden container proves nothing;
// tests/b3-android-ui/scenarios/ribbonVisibility.b3.test.ts opens the menu and asserts its contents.

export const SYNC_RIBBON_ICON: IconName = 'refresh-cw';

export const SYNC_RIBBON_LABEL = 'Sync with Nextcloud';

// Kept to two members so tests can use a plain fake.
export interface SyncRibbonHost {
  addRibbonIcon(icon: IconName, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement;
  runSyncNow(): unknown;
}

// Shares the "Sync now" entry point (runSyncNow), including its unconfigured notice and in-flight guard.
// Registered unconditionally, with no setting or platform branch.
export function registerSyncRibbon(host: SyncRibbonHost): void {
  host.addRibbonIcon(SYNC_RIBBON_ICON, SYNC_RIBBON_LABEL, () => {
    void host.runSyncNow();
  });
}
