// VersionHistoryModal's Restore buttons must share a modal-level in-flight guard: while restoring
// version A, clicking Restore on version B (or A again) is ignored until the first restore settles. jest
// runs under `node` (no `document`), so the extracted `BusyGate` is exercised directly, wired the way
// VersionHistoryModal's Restore click handler uses it.
import { BusyGate } from '../../../src/ui/VersionHistoryModal';

describe('VersionHistoryModal restore guard ([SPEC:G6-2])', () => {
  test('clicking Restore on version B while version A is still restoring is ignored', async () => {
    const gate = new BusyGate();
    let calls = 0;
    let resolveFirst!: () => void;
    const pending = new Promise<void>(r => { resolveFirst = r; });

    // Mirrors VersionHistoryModal's per-row Restore click handler: guard entered before the confirm
    // dialog / onRestore call, released in a `finally` once the restore (or its rejection) settles.
    function clickRestore(): boolean {
      if (!gate.tryEnter()) return false;
      calls += 1;
      void pending.finally(() => gate.leave());
      return true;
    }

    expect(clickRestore()).toBe(true); // restoring version A
    expect(clickRestore()).toBe(false); // clicking version B mid-flight must be ignored
    expect(calls).toBe(1);

    resolveFirst();
    await pending;

    // Once A's restore has settled, a subsequent Restore click (e.g. on B) must be allowed.
    expect(clickRestore()).toBe(true);
    expect(calls).toBe(2);
  });

  test('the guard is released even when onRestore rejects, so a later click is not stuck forever', async () => {
    const gate = new BusyGate();
    let rejectFirst!: (err: Error) => void;
    const pending = new Promise<void>((_r, rej) => { rejectFirst = rej; });

    function clickRestore(): boolean {
      if (!gate.tryEnter()) return false;
      void pending.catch(() => undefined).finally(() => gate.leave());
      return true;
    }

    expect(clickRestore()).toBe(true);
    expect(clickRestore()).toBe(false); // in flight (failing) restore still blocks a second click

    rejectFirst(new Error('network error'));
    await pending.catch(() => undefined);

    expect(clickRestore()).toBe(true); // guard released after the failure, not left stuck
  });

  test('leave() when not entered is a safe no-op (does not desync the gate)', () => {
    const gate = new BusyGate();
    gate.leave();
    expect(gate.tryEnter()).toBe(true);
  });
});
