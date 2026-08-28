import type { Command, IconName } from 'obsidian';
import { SYNC_RIBBON_ICON, SYNC_RIBBON_LABEL } from '../../../src/ui/syncRibbon';
import {
  STATUS_RIBBON_ICON,
  STATUS_RIBBON_LABEL,
  CMD_OPEN_SYNC_STATUS,
  CMD_MIRROR_FROM_REMOTE,
  registerStatusRibbon,
  registerStatusCommands,
  StatusEntryPointHost,
} from '../../../src/ui/statusEntryPoints';

// Feature 076: the desktop status bar opens the Sync Status dialog in one click, and that dialog is
// the only place holding both "Sync now" and "Mirror from remote". Mobile has no status bar
// (addStatusBarItem is documented "Not available on mobile"), which left Mirror six taps deep inside
// the settings tab. A second ribbon icon plus two commands bring it within two taps.
//
// Same shape as syncRibbon.test.ts: the wiring is extracted behind a minimal host interface so it is
// exercised for real at layer a — no `document`, no Obsidian app, just a fake recording the args.

interface RibbonCall { icon: string; title: string; callback: (evt: MouseEvent) => unknown }

function makeFakeHost(): {
  host: StatusEntryPointHost;
  ribbonCalls: RibbonCall[];
  commands: Command[];
  counts: () => { openSyncStatus: number; runRemoteMirror: number };
} {
  const ribbonCalls: RibbonCall[] = [];
  const commands: Command[] = [];
  let openSyncStatus = 0;
  let runRemoteMirror = 0;
  const host: StatusEntryPointHost = {
    addRibbonIcon(icon: IconName, title: string, callback: (evt: MouseEvent) => unknown) {
      ribbonCalls.push({ icon, title, callback });
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
  return { host, ribbonCalls, commands, counts: () => ({ openSyncStatus, runRemoteMirror }) };
}

/** Invoke a registered command's `callback`, which is the only form this module registers. */
function invoke(command: Command): void {
  const cb = command.callback;
  if (!cb) throw new Error(`command ${command.id} has no callback`);
  cb();
}

describe('registerStatusRibbon (feature 076)', () => {
  it('[SPEC:SEP-1] registers exactly one ribbon icon, visually distinct from the existing sync ribbon', () => {
    const { host, ribbonCalls } = makeFakeHost();
    registerStatusRibbon(host);

    expect(ribbonCalls).toHaveLength(1);
    expect(ribbonCalls[0].icon).toBe(STATUS_RIBBON_ICON);
    expect(ribbonCalls[0].title).toBe(STATUS_RIBBON_LABEL);
    // FR-002: two ribbon icons now sit side by side, so neither the glyph nor the tooltip may
    // collide with feature 060's. Asserting against the imported constants (rather than literals)
    // is what makes a future edit that quietly unifies them fail here.
    expect(STATUS_RIBBON_ICON).not.toBe(SYNC_RIBBON_ICON);
    expect(STATUS_RIBBON_LABEL).not.toBe(SYNC_RIBBON_LABEL);
  });

  it('[SPEC:SEP-2] its callback opens the Sync Status dialog and does not start a sync', () => {
    const { host, ribbonCalls, counts } = makeFakeHost();
    registerStatusRibbon(host);

    expect(counts().openSyncStatus).toBe(0); // nothing runs at registration time
    // jest's node env has no MouseEvent; the wrapper ignores the arg, so a dummy is enough.
    ribbonCalls[0].callback(undefined as unknown as MouseEvent);
    expect(counts().openSyncStatus).toBe(1);
    // The dialog is the entry point, not the sync itself — that stays on feature 060's ribbon.
    expect(counts().runRemoteMirror).toBe(0);
  });
});

describe('registerStatusCommands (feature 076)', () => {
  it('[SPEC:SEP-3] registers exactly the two commands that reach the dialog and the mirror', () => {
    const { host, commands } = makeFakeHost();
    registerStatusCommands(host);

    expect(commands).toHaveLength(2);
    expect(commands.map((c) => c.id)).toEqual([CMD_OPEN_SYNC_STATUS.id, CMD_MIRROR_FROM_REMOTE.id]);
    expect(commands.map((c) => c.id)).toEqual(['open-sync-status', 'mirror-from-remote']);
    // Command.icon is documented as "Icon ID to be used in the toolbar" — without one, a command
    // pinned to the mobile toolbar has nothing to draw.
    for (const c of commands) expect(c.icon).toBeTruthy();
  });

  it('[SPEC:SEP-4] the mirror command goes through runRemoteMirror, never straight to applying a plan', () => {
    const { host, commands, counts } = makeFakeHost();
    registerStatusCommands(host);

    const mirror = commands.find((c) => c.id === CMD_MIRROR_FROM_REMOTE.id)!;
    expect(counts().runRemoteMirror).toBe(0);
    invoke(mirror);
    // FR-006: runRemoteMirror owns the plan -> confirm -> apply dialog and the mirrorInProgress
    // guard. Routing through it is what keeps the destructive step behind its confirmation.
    expect(counts().runRemoteMirror).toBe(1);
    expect(counts().openSyncStatus).toBe(0);
  });

  it('[SPEC:SEP-4] the status command opens the dialog', () => {
    const { host, commands, counts } = makeFakeHost();
    registerStatusCommands(host);

    const status = commands.find((c) => c.id === CMD_OPEN_SYNC_STATUS.id)!;
    invoke(status);
    expect(counts().openSyncStatus).toBe(1);
    expect(counts().runRemoteMirror).toBe(0);
  });
});
