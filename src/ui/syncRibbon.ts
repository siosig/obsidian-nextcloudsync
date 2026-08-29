import type { IconName } from 'obsidian';

// Feature 060 (GitHub issue #19): a ribbon button that starts a sync in one click.
//
// It was added for MOBILE users, and it works there — but not through the ribbon bar. Obsidian
// mobile sets `display: none` on `.side-dock-ribbon`, so no ribbon action is ever drawn in place;
// instead the app republishes every registered ribbon action in the navigation bar's "Open menu"
// (the last item on the bar). Obsidian documents this: "The mobile app has no Ribbon. Instead, the
// ribbon actions will be available when you tap Open menu."
//
// Both halves of that were measured, and getting only the first half is what caused a wrong turn:
// feature 076 probed `.side-dock-ribbon`, found it hidden, and concluded the ribbon was dead on
// mobile — a container measurement generalized into a reachability claim. The menu builds its
// entries on tap, so nothing about it is visible to a probe taken while the menu is closed.
// tests/b3-android-ui/scenarios/ribbonVisibility.b3.test.ts now opens the menu and asserts what is
// inside it, which is the assertion that was missing.
//
// So this button is a two-tap mobile sync (Open menu -> "Sync with Nextcloud") and a one-click
// desktop sync, from a single addRibbonIcon call with no platform branching.

/** Lucide icon for the sync ribbon button (Obsidian bundles the Lucide set; IconName === string). */
export const SYNC_RIBBON_ICON: IconName = 'refresh-cw';

/** Tooltip / aria-label for the sync ribbon button. */
export const SYNC_RIBBON_LABEL = 'Sync with Nextcloud';

/**
 * Minimal host surface the ribbon wiring needs. Kept to just these two members so the wiring can be
 * unit-tested with a plain fake, without standing up the whole plugin or the Obsidian app. The real
 * plugin (which extends Obsidian's Plugin and defines runSyncNow) satisfies this structurally.
 */
export interface SyncRibbonHost {
  addRibbonIcon(icon: IconName, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement;
  runSyncNow(): unknown;
}

/**
 * Register the ribbon button that triggers a manual sync. It shares the exact "Sync now" command
 * entry point (runSyncNow), so behavior is identical — including the "Configure the server settings
 * first." notice when unconfigured and the in-flight guard inside the sync path. Registered
 * unconditionally (no setting, no config-state or platform branch) to keep a single path.
 */
export function registerSyncRibbon(host: SyncRibbonHost): void {
  host.addRibbonIcon(SYNC_RIBBON_ICON, SYNC_RIBBON_LABEL, () => {
    void host.runSyncNow();
  });
}
