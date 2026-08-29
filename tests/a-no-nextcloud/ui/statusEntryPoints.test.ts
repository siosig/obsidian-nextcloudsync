import type { Command, IconName } from 'obsidian';
import {
  CMD_OPEN_SYNC_STATUS,
  CMD_MIRROR_FROM_REMOTE,
  MIRROR_RIBBON_ICON,
  MIRROR_RIBBON_LABEL,
  registerMirrorRibbon,
  registerStatusCommands,
  StatusEntryPointHost,
} from '../../../src/ui/statusEntryPoints';
import { SYNC_RIBBON_ICON } from '../../../src/ui/syncRibbon';

// Feature 076: "Mirror from remote" was about six taps deep on mobile, because mobile has no status
// bar (addStatusBarItem is documented "Not available on mobile") and the settings tab was its only
// route. A ribbon action of its own makes it two taps: mobile does not draw the ribbon bar, but
// Obsidian republishes ribbon actions in the navigation bar's "Open menu" (asserted at b-3, with the
// menu open — see ribbonVisibility.b3.test.ts).
//
// Same shape as syncRibbon.test.ts: the wiring is extracted behind a minimal host interface so it is
// exercised for real at layer a — no `document`, no Obsidian app, just a fake recording the args.

interface RibbonCall {
  icon: IconName;
  title: string;
  callback: (evt: MouseEvent) => unknown;
}

function makeFakeHost(): {
  host: StatusEntryPointHost;
  commands: Command[];
  ribbons: RibbonCall[];
  counts: () => { openSyncStatus: number; runRemoteMirror: number };
} {
  const commands: Command[] = [];
  const ribbons: RibbonCall[] = [];
  let openSyncStatus = 0;
  let runRemoteMirror = 0;
  const host: StatusEntryPointHost = {
    addRibbonIcon(icon: IconName, title: string, callback: (evt: MouseEvent) => unknown) {
      ribbons.push({ icon, title, callback });
      // The real API returns the created element; nothing here reads it, so a stub suffices.
      return {} as HTMLElement;
    },
    addCommand(command: Command) {
      commands.push(command);
      return command;
    },
    openSyncStatus() {
      openSyncStatus++;
    },
    runRemoteMirror() {
      runRemoteMirror++;
      return Promise.resolve();
    },
  };
  return { host, commands, ribbons, counts: () => ({ openSyncStatus, runRemoteMirror }) };
}

/** Invoke a registered command's `callback`, which is the only form this module registers. */
function invoke(command: Command): void {
  const cb = command.callback;
  if (!cb) throw new Error(`command ${command.id} has no callback`);
  cb();
}

describe('registerMirrorRibbon (feature 076)', () => {
  it('[SPEC:SEP-3] registers exactly one ribbon icon, distinct from the sync one it sits next to', () => {
    const { host, ribbons, counts } = makeFakeHost();
    registerMirrorRibbon(host);

    expect(ribbons).toHaveLength(1);
    expect(ribbons[0].icon).toBe(MIRROR_RIBBON_ICON);
    expect(ribbons[0].icon).toBe('cloud-download');
    expect(ribbons[0].title).toBe(MIRROR_RIBBON_LABEL);
    // The label is what the mobile "Open menu" lists, so it is the handle b-3 looks for.
    expect(ribbons[0].title).toBe('Mirror from remote');
    // Two icons side by side must not be the same glyph, or the menu is unreadable.
    expect(ribbons[0].icon).not.toBe(SYNC_RIBBON_ICON);
    // Registration alone must not trigger anything.
    expect(counts()).toEqual({ openSyncStatus: 0, runRemoteMirror: 0 });
  });

  it('[SPEC:SEP-2] the ribbon goes through runRemoteMirror, never straight to applying a plan', () => {
    const { host, ribbons, counts } = makeFakeHost();
    registerMirrorRibbon(host);

    // No DOM in this layer, and the callback ignores its event — same as syncRibbon.test.ts.
    ribbons[0].callback(undefined as unknown as MouseEvent);
    // runRemoteMirror owns the plan -> confirm -> apply dialog and the mirrorInProgress guard.
    // Routing through it is what keeps a two-tap destructive action behind its confirmation.
    expect(counts().runRemoteMirror).toBe(1);
    expect(counts().openSyncStatus).toBe(0);
  });
});

describe('registerStatusCommands (feature 076)', () => {
  it('[SPEC:SEP-1] registers exactly the two commands that reach the dialog and the mirror', () => {
    const { host, commands, ribbons, counts } = makeFakeHost();
    registerStatusCommands(host);

    expect(commands).toHaveLength(2);
    expect(commands.map((c) => c.id)).toEqual([CMD_OPEN_SYNC_STATUS.id, CMD_MIRROR_FROM_REMOTE.id]);
    expect(commands.map((c) => c.id)).toEqual(['open-sync-status', 'mirror-from-remote']);
    // Command.icon is documented as "Icon ID to be used in the toolbar". A mobile-toolbar pin is the
    // one-tap route, and without an icon it has nothing to draw.
    for (const c of commands) expect(c.icon).toBeTruthy();
    // Commands and ribbon are registered separately; this call must not add an icon of its own.
    expect(ribbons).toHaveLength(0);
    expect(counts()).toEqual({ openSyncStatus: 0, runRemoteMirror: 0 });
  });

  it('[SPEC:SEP-2] the mirror command goes through runRemoteMirror, never straight to applying a plan', () => {
    const { host, commands, counts } = makeFakeHost();
    registerStatusCommands(host);

    invoke(commands.find((c) => c.id === CMD_MIRROR_FROM_REMOTE.id)!);
    expect(counts().runRemoteMirror).toBe(1);
    expect(counts().openSyncStatus).toBe(0);
  });

  it('[SPEC:SEP-1] the status command opens the dialog', () => {
    const { host, commands, counts } = makeFakeHost();
    registerStatusCommands(host);

    invoke(commands.find((c) => c.id === CMD_OPEN_SYNC_STATUS.id)!);
    expect(counts().openSyncStatus).toBe(1);
    expect(counts().runRemoteMirror).toBe(0);
  });
});
