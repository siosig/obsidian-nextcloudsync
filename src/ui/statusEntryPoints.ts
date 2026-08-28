import type { Command, IconName } from 'obsidian';

// Feature 076: reaching the Sync Status dialog on mobile.
//
// That dialog is the only place holding both "Sync now" and "Mirror from remote". Desktop opens it
// from the status bar in one click; mobile has no status bar — `addStatusBarItem` is documented
// "Not available on mobile" — so its only route was the settings tab, six taps deep for a mirror.
//
// The first attempt at this added a second ribbon icon. It does not work: Obsidian mobile sets
// `display: none` on `.side-dock-ribbon`, so NO ribbon action renders there — not ours, and not
// Obsidian's own seven. Measured on a real Android runtime by
// tests/b3-android-ui/scenarios/ribbonVisibility.b3.test.ts. Commands are therefore the whole of the
// mobile route, not a supplement to a ribbon:
//
//   - pinned to the mobile toolbar (Settings -> Toolbar), a command is one tap
//   - through the command palette it is two
//
// Both need `Command.icon` — "Icon ID to be used in the toolbar" — or a toolbar pin has nothing to
// draw. That is why the icons live here even though there is no ribbon left to put them on.

/**
 * Minimal host surface this wiring needs. Kept to these three members so it can be unit-tested with
 * a plain fake, without standing up the plugin or the Obsidian app. The real plugin satisfies it
 * structurally.
 */
export interface StatusEntryPointHost {
  addCommand(command: Command): unknown;
  openSyncStatus(): unknown;
  runRemoteMirror(): unknown;
}

/** Identity of the "open the dialog" command. `icon` is what a toolbar pin draws. */
export const CMD_OPEN_SYNC_STATUS = {
  id: 'open-sync-status',
  name: 'Open sync status',
  icon: 'activity' as IconName,
} as const;

/** Identity of the "mirror from remote" command. */
export const CMD_MIRROR_FROM_REMOTE = {
  id: 'mirror-from-remote',
  name: 'Mirror from remote',
  icon: 'cloud-download' as IconName,
} as const;

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
    // Goes through runRemoteMirror, which opens the dialog and runs plan -> confirm -> apply. Never
    // call applyRemoteMirror from here: that would discard unsynced local changes with no prompt.
    callback: () => {
      void host.runRemoteMirror();
    },
  });
}
