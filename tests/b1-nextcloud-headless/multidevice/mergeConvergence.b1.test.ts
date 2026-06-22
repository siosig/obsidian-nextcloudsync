// Layer B — multi-device merge convergence (engine, live server).
// Models the user's timeline with a Desktop (D) and a Mobile/iPhone (M):
//   D: edit file A          (local edit)
//   D: sync                 (uploads A to remote)
//   M: sync → merges A      (M had its own divergent edit of A; 3-point compare → conflict → auto-merge,
//                            merged content written locally AND pushed to remote = resolveByWrite)
//   M: sync → A = ???       (THE question)
//
// Answer asserted here: on the SECOND M sync, A is **Unchanged / converged** — M's Local == Base ==
// Remote (all = the merged result), A is no longer flagged conflicted, no conflict-copy file is
// created, and nothing churns. This is the self-healing convergence guarantee (spec §6.4 / §10), and
// it must hold across BOTH the real-scan path (M's own push moved the root ETag) and, on a further
// no-op sync, the root-ETag short-circuit path (spec 023 §8a.5).
//
// Mobile (M) is configured like an iPhone: no periodic sync, watch-on-change OFF. Those are trigger
// settings only — they govern WHEN a sync starts, not what a manually-invoked sync does — so the test
// drives M's syncs explicitly, which is exactly how an iPhone user's manual syncs behave.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice } from '../support/engineDevice';
import { decodeBuf } from '../support/helpers';

describeLive('Layer B — multi-device merge convergence (D desktop / M iPhone)', (getEnv) => {
  let ws: IsolatedWorkspace;
  let baseClient: NextcloudClient;

  beforeAll(async () => {
    const s = await setupWorkspace(getEnv());
    ws = s.ws;
    baseClient = s.client;
  });

  afterAll(async () => {
    if (baseClient && ws) await cleanupWorkspace(baseClient, ws);
  });

  const A = 'A.md';
  const remoteA = (): Promise<string> => baseClient.downloadFile(A).then(decodeBuf);

  it('D edits A → D sync → M sync merges A → M sync again leaves A unchanged (converged, no re-conflict, no churn)', async () => {
    const env = getEnv();

    // D = desktop (defaults). M = iPhone: periodic sync off + watch-on-change off (trigger settings).
    const d = makeDevice(env, ws.remoteBase, 'D-desktop');
    const m = makeDevice(env, ws.remoteBase, 'M-iphone', { syncIntervalMinutes: 0, watchOnChangeEnabled: false });

    // ── Baseline: A exists on both, in sync ───────────────────────────────────────────────
    d.vault.seedLocal('anchor.md', 'anchor'); // keeps the folder non-empty across the run
    d.vault.seedLocal(A, 'alpha\nbravo\ncharlie\n');
    await d.sync();                            // remote A = base
    await m.sync();                            // M downloads A (base), now tracked as Base
    expect(m.vault.readLocal(A)).toBe('alpha\nbravo\ncharlie\n');

    // ── D: edit A (line 1) then sync → remote A = D's version ─────────────────────────────
    d.vault.seedLocal(A, 'ALPHA-D\nbravo\ncharlie\n');
    await d.sync();
    expect(await remoteA()).toBe('ALPHA-D\nbravo\ncharlie\n');

    // M has its OWN divergent edit of A (line 3) made locally before it syncs.
    m.vault.seedLocal(A, 'alpha\nbravo\nCHARLIE-M\n');

    // ── M: sync #1 → conflict (Local≠Base & Remote≠Base) → auto-merge → write local + push ──
    await m.sync();
    const mergedLocal = m.vault.readLocal(A)!;
    const mergedRemote = await remoteA();

    // A real merge happened with NO data loss: both sides' edits survive.
    expect(mergedLocal).toContain('ALPHA-D');   // D's remote edit preserved
    expect(mergedLocal).toContain('CHARLIE-M'); // M's local edit preserved
    // resolveByWrite pushed the merged result, so M's local == remote (converged this round).
    expect(mergedLocal).toBe(mergedRemote);
    // Clean auto-merge ⇒ A is NOT left flagged as conflicted, and no conflict-copy file was spawned.
    expect(m.stateDB.getFile(A)?.isConflicted ?? false).toBe(false);
    expect(localCopiesOfA(m)).toBe(1);

    // ── M: sync #2 → THE question. A must be UNCHANGED (Local == Base == Remote) ───────────
    await m.sync();
    expect(m.vault.readLocal(A)).toBe(mergedLocal); // local unchanged
    expect(await remoteA()).toBe(mergedRemote);     // remote unchanged
    expect(m.stateDB.getFile(A)?.isConflicted ?? false).toBe(false); // still not conflicted
    // No conflict-copy proliferation: A is the only A-named note locally.
    expect(localCopiesOfA(m)).toBe(1);

    // ── M: sync #3 → same outcome via the root-ETag short-circuit path (spec 023) ──────────
    // M's own push in sync #1 moved the root ETag, so sync #2 was a real scan that re-stored it;
    // sync #3 (nothing changed) now matches and short-circuits — A still stays put.
    await m.sync();
    expect(m.vault.readLocal(A)).toBe(mergedLocal);
    expect(await remoteA()).toBe(mergedRemote);
    expect(m.stateDB.getFile(A)?.isConflicted ?? false).toBe(false);

    // ── Whole-system convergence: D also ends up on the merged content ─────────────────────
    await d.sync();
    expect(d.vault.readLocal(A)).toBe(mergedLocal);
  }, 180_000);
});

/** Count local notes whose basename is "A" (detects "A (conflicted copy ...).md" proliferation). */
function localCopiesOfA(device: { vault: { vault: { getFiles(): { path: string }[] } } }): number {
  return device.vault.vault.getFiles().filter((f) => /(^|\/)A( \(conflicted copy[^)]*\))?\.md$/.test(f.path)).length;
}
