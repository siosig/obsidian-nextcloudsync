import type { Command } from 'obsidian';
import {
  CMD_OPEN_SYNC_STATUS,
  CMD_MIRROR_FROM_REMOTE,
  registerStatusCommands,
  StatusEntryPointHost,
} from '../../../src/ui/statusEntryPoints';

// Feature 076: the Sync Status dialog is the only place holding both "Sync now" and "Mirror from
// remote". Desktop opens it from the status bar; mobile has none (addStatusBarItem is documented
// "Not available on mobile"), which left Mirror six taps deep in the settings tab.
//
// A second ribbon icon was tried first. It cannot work: Obsidian mobile sets display:none on
// .side-dock-ribbon, so no ribbon action renders there at all — measured on a real Android runtime
// by ribbonVisibility.b3.test.ts. These commands are therefore the whole of the mobile route.
//
// Same shape as syncRibbon.test.ts: the wiring is extracted behind a minimal host interface so it is
// exercised for real at layer a — no `document`, no Obsidian app, just a fake recording the args.

function makeFakeHost(): {
  host: StatusEntryPointHost;
  commands: Command[];
  counts: () => { openSyncStatus: number; runRemoteMirror: number };
} {
  const commands: Command[] = [];
  let openSyncStatus = 0;
  let runRemoteMirror = 0;
  const host: StatusEntryPointHost = {
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
  return { host, commands, counts: () => ({ openSyncStatus, runRemoteMirror }) };
}

/** Invoke a registered command's `callback`, which is the only form this module registers. */
function invoke(command: Command): void {
  const cb = command.callback;
  if (!cb) throw new Error(`command ${command.id} has no callback`);
  cb();
}

describe('registerStatusCommands (feature 076)', () => {
  it('[SPEC:SEP-1] registers exactly the two commands that reach the dialog and the mirror', () => {
    const { host, commands, counts } = makeFakeHost();
    registerStatusCommands(host);

    expect(commands).toHaveLength(2);
    expect(commands.map((c) => c.id)).toEqual([CMD_OPEN_SYNC_STATUS.id, CMD_MIRROR_FROM_REMOTE.id]);
    expect(commands.map((c) => c.id)).toEqual(['open-sync-status', 'mirror-from-remote']);
    // Command.icon is documented as "Icon ID to be used in the toolbar". Since the ribbon is invisible
    // on mobile, a toolbar pin is the one-tap route — and without an icon it has nothing to draw.
    for (const c of commands) expect(c.icon).toBeTruthy();
    // Registration alone must not trigger anything.
    expect(counts()).toEqual({ openSyncStatus: 0, runRemoteMirror: 0 });
  });

  it('[SPEC:SEP-2] the mirror command goes through runRemoteMirror, never straight to applying a plan', () => {
    const { host, commands, counts } = makeFakeHost();
    registerStatusCommands(host);

    const mirror = commands.find((c) => c.id === CMD_MIRROR_FROM_REMOTE.id)!;
    invoke(mirror);
    // runRemoteMirror owns the plan -> confirm -> apply dialog and the mirrorInProgress guard.
    // Routing through it is what keeps the destructive step behind its confirmation.
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
