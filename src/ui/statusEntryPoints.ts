import type { Command, IconName } from 'obsidian';

// Feature 076: reaching the Sync Status dialog on mobile.
//
// On desktop the status bar opens that dialog in one click, and the dialog is the only place that
// holds both "Sync now" and "Mirror from remote". Mobile has no status bar — `addStatusBarItem` is
// documented "Not available on mobile" — so its only route was the settings tab, six taps deep for
// a mirror. A second ribbon icon fixes that: Obsidian renders ribbon icons inside the left-sidebar
// hamburger menu on mobile (the same placement feature 060 relies on), so the dialog is one tap and
// either action is two.
//
// The commands are the second route, not the guarantee. Pinned to the mobile toolbar they are a
// single tap, but that is the user's own configuration; the ribbon is what makes two taps hold
// without one.
//
// Feature 060's sync ribbon is deliberately left alone. Retargeting it at this dialog would have
// avoided a second icon, but it would also have turned the one-tap sync that issue #19 asked for
// back into two taps.

/**
 * Lucide icon for the sync-status ribbon button. Must stay different from {@link
 * import('./syncRibbon').SYNC_RIBBON_ICON} — the two icons now sit next to each other.
 */
export const STATUS_RIBBON_ICON: IconName = 'activity';

/** Tooltip / aria-label for the sync-status ribbon button. */
export const STATUS_RIBBON_LABEL = 'Nextcloud sync status';

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

/** Identity of the "open the dialog" command. `icon` is what a toolbar pin draws. */
export const CMD_OPEN_SYNC_STATUS = {
  id: 'open-sync-status',
  name: 'Open sync status',
  icon: STATUS_RIBBON_ICON,
} as const;

/** Identity of the "mirror from remote" command. */
export const CMD_MIRROR_FROM_REMOTE = {
  id: 'mirror-from-remote',
  name: 'Mirror from remote',
  icon: 'cloud-download' as IconName,
} as const;

/**
 * Register the ribbon button that opens the Sync Status dialog. Registered unconditionally — no
 * setting, no config-state or platform branch — so every user reaches it the same way.
 *
 * It opens the dialog rather than mirroring directly: one icon then covers both actions, and the
 * destructive one stays behind the dialog's confirmation step.
 */
export function registerStatusRibbon(host: StatusEntryPointHost): void {
  host.addRibbonIcon(STATUS_RIBBON_ICON, STATUS_RIBBON_LABEL, () => {
    host.openSyncStatus();
  });
}

/**
 * Register the command-palette entries for the same two destinations, so they can also be pinned to
 * the mobile toolbar or bound to a hotkey.
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
    // Goes through runRemoteMirror, which opens the dialog and runs plan -> confirm -> apply. Never
    // call applyRemoteMirror from here: that would discard unsynced local changes with no prompt.
    callback: () => {
      void host.runRemoteMirror();
    },
  });
}
