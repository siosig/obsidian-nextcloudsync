// Layer B (MM-11) — feature 039: two real devices edit the SAME line of one file, producing conflict
// markers, then keep syncing. This reproduces the real-world casualty (a 62KB / 3-deep-marker / 12x
// duplication daily note) at the live-server level and proves the re-entrancy guard holds: once
// markers exist, repeated syncs leave them at a SINGLE level and do NOT grow the file (no geometric
// re-wrapping). Self-healing: when the markers are removed, normal merge resumes.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice, Device } from '../support/engineDevice';
import { decodeBuf } from '../support/helpers';
import { hasNestedConflictMarkers } from '../../../src/sync/merge/MergeEngine';

const openCount = (s: string): number => (s.match(/^<<<<<<< LOCAL/gm) || []).length;

describeLive('Layer B (MM-11) — conflict-marker re-entrancy does not grow the file', (getEnv) => {
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

  const remote = (p: string): Promise<string> => baseClient.downloadFile(p).then(decodeBuf);

  it('[SPEC:MM-11] same-line conflict → markers stay single-level and the file does not expand across re-syncs', async () => {
    const over = { autoMergeFileStrategy: 'merge' as const };
    const d = makeDevice(getEnv(), ws.remoteBase, 'D-mm', over);
    const m = makeDevice(getEnv(), ws.remoteBase, 'M-mm', over);
    const f = 'mm-reentrancy.md';

    // Baseline: both in sync on the same body.
    d.vault.seedLocal('anchor.md', 'anchor');
    d.vault.seedLocal(f, 'line1\nshared line\nline3\n');
    await d.sync();
    await m.sync();

    // D and M edit the SAME line differently → a genuine conflict.
    d.vault.seedLocal(f, 'line1\nD wrote this\nline3\n');
    await d.sync(); // remote = D version
    m.vault.seedLocal(f, 'line1\nM wrote this\nline3\n');
    await m.sync(); // M resolves: merge strategy on a same-line conflict → conflict markers, pushed

    const afterFirst = m.vault.readLocal(f)!;
    expect(openCount(afterFirst)).toBe(1);                 // exactly one conflict region
    expect(hasNestedConflictMarkers(afterFirst)).toBe(false);
    expect(afterFirst).toContain('D wrote this');
    expect(afterFirst).toContain('M wrote this');         // no data loss: both sides kept
    const firstSize = afterFirst.length;

    // Keep syncing both devices WITHOUT resolving the markers. The re-entrancy guard must safe-hold:
    // the marked body must never be re-merged into deeper/duplicated markers.
    for (let round = 0; round < 4; round++) {
      await d.sync();
      await m.sync();
      const localBody = m.vault.readLocal(f)!;
      const remoteBody = await remote(f);
      // Single-level on both sides, never nested, never growing beyond the first marker version.
      expect(openCount(localBody)).toBeLessThanOrEqual(1);
      expect(openCount(remoteBody)).toBeLessThanOrEqual(1);
      expect(hasNestedConflictMarkers(localBody)).toBe(false);
      expect(hasNestedConflictMarkers(remoteBody)).toBe(false);
      expect(localBody.length).toBeLessThanOrEqual(firstSize);
    }

    // Self-healing: the user resolves by removing markers and keeping one version.
    m.vault.seedLocal(f, 'line1\nresolved by hand\nline3\n');
    await m.sync();
    await d.sync();
    await m.sync();
    expect(openCount(m.vault.readLocal(f)!)).toBe(0);     // markers gone, converged
    expect(await remote(f)).toContain('resolved by hand');
  }, 120_000);
});
