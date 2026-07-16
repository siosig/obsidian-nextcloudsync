import type { IconName } from 'obsidian';

// Feature 060 (GitHub issue #19): a ribbon button so mobile users can start a sync in one tap
// instead of opening the command palette or the settings tab. On mobile, Obsidian renders ribbon
// icons inside the left-sidebar hamburger menu, so a single addRibbonIcon call covers desktop and
// mobile with no platform branching.

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
