import type { Command, IconName } from 'obsidian';

// Feature 076: reaching "Mirror from remote" and the Sync Status dialog on mobile in at most two
// taps.
//
// Desktop has both in reach already: the status bar opens the dialog in one click, and the dialog
// holds "Sync now" and "Mirror from remote" side by side. Mobile has no status bar
// (`addStatusBarItem` is documented "Not available on mobile"), so the settings tab was the only
// route to either — around six taps for a mirror.
//
// The route that fixes it is the ribbon, which mobile keeps despite not drawing a ribbon bar:
// `.side-dock-ribbon` is `display: none`, but Obsidian republishes every registered ribbon action
// inside the navigation bar's "Open menu". Two taps, no user configuration. Feature 060's sync
// button has always ridden on this; measuring only the hidden container is what briefly made it look
// otherwise (see the note in syncRibbon.ts).
//
// So the mirror gets its OWN ribbon action rather than an icon that opens the dialog. Routing
// through the dialog would cost a third tap for the one action the user asked to reach in two, and
// the dialog is not what makes the mirror safe — runRemoteMirror always opens a confirmation
// showing the download and delete counts, from every entry point.
//
// The commands below are the second route, not the guarantee: pinned to the mobile toolbar
// (Settings -> Mobile -> Manage toolbar options -> Add global command) they are a single tap, but
// that is the user's own configuration. They also carry the Sync Status dialog, which is worth a
// command and not worth a third ribbon icon.

/** Lucide icon for the mirror ribbon button. Distinct from {@link import('./syncRibbon').SYNC_RIBBON_ICON}: the two sit next to each other. */
export const MIRROR_RIBBON_ICON: IconName = 'cloud-download';

/** Tooltip / aria-label for the mirror ribbon button, and the label the mobile "Open menu" shows. */
export const MIRROR_RIBBON_LABEL = 'Mirror from remote';

/**
 * Minimal host surface this wiring needs. Kept to these four members so it can be unit-tested with a
 * plain fake, without standing up the plugin or the Obsidian app. The real plugin satisfies it
 * structurally.
 */
export interface StatusEntryPointHost {
  addRibbonIcon(icon: IconName, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement;
  addCommand(command: Command): unknown;
  openSyncStatus(): unknown;
  runRemoteMirror(): unknown;
}

/** Identity of the "open the dialog" command. `icon` is what a mobile-toolbar pin draws. */
export const CMD_OPEN_SYNC_STATUS = {
  id: 'open-sync-status',
  name: 'Open sync status',
  icon: 'activity' as IconName,
} as const;

/** Identity of the "mirror from remote" command. */
export const CMD_MIRROR_FROM_REMOTE = {
  id: 'mirror-from-remote',
  name: MIRROR_RIBBON_LABEL,
  icon: MIRROR_RIBBON_ICON,
} as const;

/**
 * Register the ribbon button for "Mirror from remote" — one click on desktop, two taps on mobile
 * (Open menu -> "Mirror from remote"). Registered unconditionally: no setting, no config-state or
 * platform branch, so every user reaches it the same way.
 *
 * It calls runRemoteMirror, which plans, shows the confirmation with its counts, and only then
 * applies. Never call applyRemoteMirror from a ribbon: that would discard unsynced local changes
 * with no prompt.
 */
export function registerMirrorRibbon(host: StatusEntryPointHost): void {
  host.addRibbonIcon(MIRROR_RIBBON_ICON, MIRROR_RIBBON_LABEL, () => {
    void host.runRemoteMirror();
  });
}

/**
 * Register the command-palette entries for the Sync Status dialog and for Mirror from remote, so
 * both can be pinned to the mobile toolbar or bound to a hotkey.
 *
 * Both use a plain `callback`, not `checkCallback`: `openSyncStatus` and `runRemoteMirror` already
 * own the unconfigured, signed-out and already-running cases, each with its own notice. Hiding the
 * commands instead would replace those explanations with silence.
 */
export function registerStatusCommands(host: StatusEntryPointHost): void {
  host.addCommand({
    ...CMD_OPEN_SYNC_STATUS,
    callback: () => {
      host.openSyncStatus();
    },
  });
  host.addCommand({
    ...CMD_MIRROR_FROM_REMOTE,
    // Same entry point as the ribbon above: plan -> confirm -> apply, never a bare apply.
    callback: () => {
      void host.runRemoteMirror();
    },
  });
}
