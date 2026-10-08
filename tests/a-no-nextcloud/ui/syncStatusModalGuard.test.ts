// The force-resolve "Apply" (per-file) and "Apply to all" (bulk) buttons must be guarded against
// double-execution by an INSTANCE FIELD that survives `render()`, not by the transient DOM `disabled`
// attribute of a button re-created every render. jest runs under `node` (no `document`), so the extracted
// `KeyedBusyGate` is exercised directly, wired the way SyncStatusModal's click handlers use it.
import { KeyedBusyGate } from '../../../src/ui/SyncStatusModal';

describe('SyncStatusModal force-resolve guard ([SPEC:G6-1])', () => {
  test('per-file: a re-render recreating the Apply button cannot re-trigger the same in-flight resolution', async () => {
    const gate = new KeyedBusyGate();
    let calls = 0;
    let resolveFirst!: () => void;
    const pending = new Promise<void>(r => { resolveFirst = r; });

    // Mirrors SyncStatusModal's per-file Apply click handler: `applyBtn.addEventListener('click', ...)`.
    function clickApply(path: string): boolean {
      if (!gate.tryEnter(path)) return false;
      calls += 1;
      void pending.then(() => gate.leave(path));
      return true;
    }

    expect(clickApply('conflict.md')).toBe(true); // first Apply click starts the resolution
    // Simulate an unrelated re-render (filter toggle / "Sync now" completing) recreating a fresh,
    // non-disabled button for the same row while the first call is still pending, then the user
    // clicking it again.
    expect(clickApply('conflict.md')).toBe(false);
    expect(calls).toBe(1); // the second click must NOT re-invoke onForceResolve

    resolveFirst();
    await pending;

    // Once the first resolution has settled, a fresh click is legitimate and must be allowed.
    expect(clickApply('conflict.md')).toBe(true);
    expect(calls).toBe(2);
  });

  test('per-file: different paths resolve independently (one in-flight file does not block another)', () => {
    const gate = new KeyedBusyGate();
    expect(gate.tryEnter('a.md')).toBe(true);
    expect(gate.tryEnter('b.md')).toBe(true); // unrelated file, must not be blocked by a.md
    expect(gate.tryEnter('a.md')).toBe(false); // a.md is still in flight
    gate.leave('a.md');
    expect(gate.tryEnter('a.md')).toBe(true);
  });

  test('bulk: a re-render recreating the "Apply to all" button cannot re-trigger the same in-flight batch', async () => {
    const gate = new KeyedBusyGate();
    const BULK_KEY = 'bulk';
    let calls = 0;
    let resolveFirst!: () => void;
    const pending = new Promise<void>(r => { resolveFirst = r; });

    function clickApplyToAll(): boolean {
      if (!gate.tryEnter(BULK_KEY)) return false;
      calls += 1;
      void pending.then(() => gate.leave(BULK_KEY));
      return true;
    }

    expect(clickApplyToAll()).toBe(true);
    expect(clickApplyToAll()).toBe(false); // stale re-rendered button must not re-trigger the batch
    expect(calls).toBe(1);

    resolveFirst();
    await pending;
    expect(clickApplyToAll()).toBe(true);
    expect(calls).toBe(2);
  });

  test('leave() on a key never entered is a safe no-op (does not desync the gate)', () => {
    const gate = new KeyedBusyGate();
    gate.leave('never-entered.md');
    expect(gate.tryEnter('never-entered.md')).toBe(true);
  });
});
