// Layer B — multi-device merge convergence (engine, live server). Timeline with Desktop (D) and Mobile (M): D edits A and
// syncs; M (which had its own divergent edit of A) syncs -> conflict -> auto-merge, merged content written locally AND
// pushed (resolveByWrite); M syncs again.
// Asserted: on the SECOND M sync A is Unchanged / converged (Local == Base == Remote == the merged result), not flagged
// conflicted, no conflict-copy file, no churn (docs/spec.md §6.4, §10). It must hold for the real-scan path (M's own push
// moved the root ETag) and, on a further no-op sync, the root-ETag short-circuit (docs/spec.md §8a.5).
// M is configured like an iPhone (no periodic sync, watch-on-change OFF): those only govern WHEN a sync starts, so the
// test drives M's syncs explicitly.
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

    const d = makeDevice(env, ws.remoteBase, 'D-desktop');
    const m = makeDevice(env, ws.remoteBase, 'M-iphone', { syncIntervalMinutes: 0, watchOnChangeEnabled: false });

    d.vault.seedLocal('anchor.md', 'anchor'); // keeps the folder non-empty across the run
    d.vault.seedLocal(A, 'alpha\nbravo\ncharlie\n');
    await d.sync();                            // remote A = base
    await m.sync();                            // M downloads A (base), now tracked as Base
    expect(m.vault.readLocal(A)).toBe('alpha\nbravo\ncharlie\n');

    d.vault.seedLocal(A, 'ALPHA-D\nbravo\ncharlie\n');
    await d.sync();
    expect(await remoteA()).toBe('ALPHA-D\nbravo\ncharlie\n');

    m.vault.seedLocal(A, 'alpha\nbravo\nCHARLIE-M\n');

    await m.sync();
    const mergedLocal = m.vault.readLocal(A)!;
    const mergedRemote = await remoteA();

    expect(mergedLocal).toContain('ALPHA-D');   // D's remote edit preserved
    expect(mergedLocal).toContain('CHARLIE-M'); // M's local edit preserved
    // resolveByWrite pushed the merged result, so M's local == remote (converged this round).
    expect(mergedLocal).toBe(mergedRemote);
    // Clean auto-merge ⇒ A is NOT left flagged as conflicted, and no conflict-copy file was spawned.
    expect(m.stateDB.getFile(A)?.isConflicted ?? false).toBe(false);
    expect(localCopiesOfA(m)).toBe(1);

    await m.sync();
    expect(m.vault.readLocal(A)).toBe(mergedLocal); // local unchanged
    expect(await remoteA()).toBe(mergedRemote);     // remote unchanged
    expect(m.stateDB.getFile(A)?.isConflicted ?? false).toBe(false); // still not conflicted
    // No conflict-copy proliferation: A is the only A-named note locally.
    expect(localCopiesOfA(m)).toBe(1);

    // M's own push in sync #1 moved the root ETag, so sync #2 was a real scan that re-stored it;
    // sync #3 (nothing changed) now matches and short-circuits — A still stays put.
    await m.sync();
    expect(m.vault.readLocal(A)).toBe(mergedLocal);
    expect(await remoteA()).toBe(mergedRemote);
    expect(m.stateDB.getFile(A)?.isConflicted ?? false).toBe(false);

    await d.sync();
    expect(d.vault.readLocal(A)).toBe(mergedLocal);
  }, 180_000);
});

/** Count local notes whose basename is "A" (detects "A (conflicted copy ...).md" proliferation). */
function localCopiesOfA(device: { vault: { vault: { getFiles(): { path: string }[] } } }): number {
  return device.vault.vault.getFiles().filter((f) => /(^|\/)A( \(conflicted copy[^)]*\))?\.md$/.test(f.path)).length;
}
