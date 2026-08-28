import type { IconName } from 'obsidian';

// Feature 060 (GitHub issue #19): a ribbon button that starts a sync in one click.
//
// It was added for MOBILE users, on the belief that "Obsidian renders ribbon icons inside the
// left-sidebar hamburger menu on mobile". That belief is wrong, and feature 076 disproved it by
// measuring a real Android runtime: Obsidian mobile sets `display: none` on `.side-dock-ribbon`, so
// no ribbon action renders there — not this one, and not Obsidian's own. Clause RIB-3 had waived the
// claim to a manual check that was never performed, which is how it survived. See
// tests/b3-android-ui/scenarios/ribbonVisibility.b3.test.ts.
//
// The button stays: one-click sync is worth having on desktop, where the ribbon does render. The
// mobile route is the "Sync now" command, pinned to the mobile toolbar or run from the palette.
// Still a single addRibbonIcon call with no platform branching — Obsidian does the hiding.

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
