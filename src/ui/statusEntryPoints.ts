import type { Command, IconName } from 'obsidian';

// Mobile has no status bar, so the ribbon is the two-tap route: `.side-dock-ribbon` is hidden, but Obsidian
// republishes every registered ribbon action in the navigation bar's "Open menu".
// The mirror gets its own ribbon action because runRemoteMirror always confirms with the download and
// delete counts from every entry point. The commands below are the second route (pinnable to the mobile toolbar).

// Distinct from SYNC_RIBBON_ICON: the two buttons sit side by side.
export const MIRROR_RIBBON_ICON: IconName = 'cloud-download';

export const MIRROR_RIBBON_LABEL = 'Mirror from remote';

// Kept to four members so tests can use a plain fake.
export interface StatusEntryPointHost {
  addRibbonIcon(icon: IconName, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement;
  addCommand(command: Command): unknown;
  openSyncStatus(): unknown;
  runRemoteMirror(): unknown;
}

export const CMD_OPEN_SYNC_STATUS = {
  id: 'open-sync-status',
  name: 'Open sync status',
  icon: 'activity' as IconName,
} as const;

export const CMD_MIRROR_FROM_REMOTE = {
  id: 'mirror-from-remote',
  name: MIRROR_RIBBON_LABEL,
  icon: MIRROR_RIBBON_ICON,
} as const;

// Registered unconditionally, with no setting or platform branch. Calls runRemoteMirror (plan, confirm with counts, apply);
// never call applyRemoteMirror from a ribbon, which would discard unsynced local changes without a prompt.
export function registerMirrorRibbon(host: StatusEntryPointHost): void {
  host.addRibbonIcon(MIRROR_RIBBON_ICON, MIRROR_RIBBON_LABEL, () => {
    void host.runRemoteMirror();
  });
}

// Plain `callback`, not `checkCallback`: openSyncStatus and runRemoteMirror already explain the unconfigured,
// signed-out and already-running cases; hiding the commands would replace those notices with silence.
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
