// Layer B — two-client merge-strategy × edit-timing matrix against a live Nextcloud (Docker).
// Two real SyncEngine devices (D, M) share one remote folder. For every Auto Merge File strategy
// and across the edit-timing permutations (sequential / concurrent D-first / concurrent M-first /
// repeated rounds) we assert the plugin converges correctly: no data loss for the winning side, the
// merge strategy preserves BOTH non-overlapping edits with NO duplicated blocks (feature 038's true
// 3-way base), and a follow-up sync leaves both sides identical and unconflicted (self-healing).
//
// The merge base store (feature 038) is wired into each device by makeDevice exactly as in
// production, so this exercises the real cross-device 3-way merge — the only place the empty-base
// duplication bug could regress.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice, Device } from '../support/engineDevice';
import { decodeBuf } from '../support/helpers';
import { DavSyncSettings } from '../../../src/types';

const occ = (s: string, needle: string): number => s.split(needle).length - 1;

describeLive('Layer B — 2-client merge-strategy × timing matrix', (getEnv) => {
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

  /** Fresh device pair sharing the remote; M (resolver) carries the strategy under test. */
  function pair(tag: string, over: Partial<DavSyncSettings>): { d: Device; m: Device } {
    const d = makeDevice(getEnv(), ws.remoteBase, `D-${tag}`, over);
    const m = makeDevice(getEnv(), ws.remoteBase, `M-${tag}`, { syncIntervalMinutes: 0, watchOnChangeEnabled: false, ...over });
    return { d, m };
  }

  /** Seed file `f` identically on both devices (both end with base[f] = body). */
  async function seedBoth(d: Device, m: Device, f: string, body: string): Promise<void> {
    d.vault.seedLocal('anchor.md', 'anchor'); // keep the remote folder non-empty across the run
    d.vault.seedLocal(f, body);
    await d.sync();   // remote f = body; D base = body
    await m.sync();   // M downloads f; M base = body
  }

  // ── Sequential edits (no conflict): each side's change propagates cleanly ──────────────────────
  it('sequential edits propagate with no spurious conflict', async () => {
    const { d, m } = pair('seq', { autoMergeFileStrategy: 'merge' });
    const f = 'seq.md';
    await seedBoth(d, m, f, 'one\ntwo\nthree\n');

    d.vault.seedLocal(f, 'one-D\ntwo\nthree\n'); await d.sync();
    await m.sync(); // M unchanged locally → just downloads D's edit (no conflict)
    expect(m.vault.readLocal(f)).toBe('one-D\ntwo\nthree\n');
    expect(m.stateDB.getFile(f)?.isConflicted ?? false).toBe(false);

    m.vault.seedLocal(f, 'one-D\ntwo\nthree-M\n'); await m.sync();
    await d.sync();
    expect(d.vault.readLocal(f)).toBe('one-D\ntwo\nthree-M\n');
    expect(d.stateDB.getFile(f)?.isConflicted ?? false).toBe(false);
  }, 180_000);

  // ── merge strategy: both non-overlapping edits survive, no duplicated blocks, converge ─────────
  it.each([
    ['D-first', false],
    ['M-first', true],
  ])('merge strategy, concurrent edits (%s) → both edits kept, no duplication, converge', async (_label, mFirst) => {
    const { d, m } = pair(`merge-${_label}`, { autoMergeFileStrategy: 'merge' });
    const f = `merge_${_label}.md`;
    await seedBoth(d, m, f, 'L1\nL2\nL3\n');

    // Divergent edits from the same base: D edits line1, M edits line3.
    d.vault.seedLocal(f, 'L1-D\nL2\nL3\n');
    m.vault.seedLocal(f, 'L1\nL2\nL3-M\n');

    if (mFirst) {
      await m.sync(); // M uploads its edit first
      await d.sync(); // D now conflicts and merges
      await m.sync(); // M pulls the merged result
    } else {
      await d.sync(); // D uploads its edit first
      await m.sync(); // M conflicts and merges (resolveByWrite pushes merged)
      await d.sync(); // D pulls the merged result
    }

    const dC = d.vault.readLocal(f)!;
    const mC = m.vault.readLocal(f)!;
    expect(dC).toBe(mC);              // both devices converged to identical content
    expect(dC).toBe(await remote(f)); // and the server matches
    expect(dC).toContain('L1-D');     // D's edit preserved (no data loss)
    expect(dC).toContain('L3-M');     // M's edit preserved (no data loss)
    expect(occ(dC, 'L2')).toBe(1);    // shared block NOT duplicated (feature 038 base)
    expect(occ(dC, 'L1-D')).toBe(1);
    expect(occ(dC, 'L3-M')).toBe(1);
    expect(m.stateDB.getFile(f)?.isConflicted ?? false).toBe(false);
  }, 180_000);

  // ── merge strategy, repeated conflict rounds: duplication must not accumulate (feature 038) ────
  it('merge strategy, repeated conflict rounds do not accumulate duplicated blocks', async () => {
    const { d, m } = pair('merge-rounds', { autoMergeFileStrategy: 'merge' });
    const f = 'rounds.md';
    await seedBoth(d, m, f, 'A\nB\nC\n');

    for (let round = 1; round <= 3; round++) {
      // Each round: D and M make distinct, non-overlapping edits from the current converged base.
      const cur = d.vault.readLocal(f)!;
      d.vault.seedLocal(f, cur.replace('A', `A-D${round}`));
      m.vault.seedLocal(f, cur.replace('C', `C-M${round}`));
      await d.sync();
      await m.sync(); // merge
      await d.sync(); // converge
    }

    const dC = d.vault.readLocal(f)!;
    expect(dC).toBe(await remote(f));
    expect(occ(dC, 'B')).toBe(1);       // the never-edited shared line appears exactly once
    expect(dC).toContain('A-D3');       // latest edits from both sides present
    expect(dC).toContain('C-M3');
    // Sanity: the file did not blow up to many lines (duplication would multiply line count).
    expect(dC.split('\n').filter((l) => l.length > 0).length).toBeLessThanOrEqual(4);
  }, 240_000);

  // ── deterministic strategies: the configured winner takes both sides, the loser is overwritten ─
  it('local-win → M (resolver/local) content wins on both sides', async () => {
    const { d, m } = pair('local', { autoMergeFileStrategy: 'local-win' });
    const f = 'local.md';
    await seedBoth(d, m, f, 'base\n');
    d.vault.seedLocal(f, 'D-version\n'); await d.sync();
    m.vault.seedLocal(f, 'M-version\n'); await m.sync(); // conflict → local-win → M wins
    await d.sync();
    expect(m.vault.readLocal(f)).toBe('M-version\n');
    expect(await remote(f)).toBe('M-version\n');
    expect(d.vault.readLocal(f)).toBe('M-version\n');
  }, 180_000);

  it('remote-win → D (remote) content wins on both sides', async () => {
    const { d, m } = pair('remote', { autoMergeFileStrategy: 'remote-win' });
    const f = 'remote.md';
    await seedBoth(d, m, f, 'base\n');
    d.vault.seedLocal(f, 'D-version\n'); await d.sync();
    m.vault.seedLocal(f, 'M-version\n'); await m.sync(); // conflict → remote-win → D wins
    await d.sync();
    expect(m.vault.readLocal(f)).toBe('D-version\n');
    expect(await remote(f)).toBe('D-version\n');
    expect(d.vault.readLocal(f)).toBe('D-version\n');
  }, 180_000);

  it('biggest-size → the larger side wins on both sides', async () => {
    const { d, m } = pair('big', { autoMergeFileStrategy: 'biggest-size' });
    const f = 'big.md';
    await seedBoth(d, m, f, 'base\n');
    d.vault.seedLocal(f, 'small\n');                 // smaller
    m.vault.seedLocal(f, 'much-larger-content-here\n'); // larger
    await d.sync();
    await m.sync(); // conflict → biggest-size → M (larger) wins
    await d.sync();
    expect(m.vault.readLocal(f)).toBe('much-larger-content-here\n');
    expect(await remote(f)).toBe('much-larger-content-here\n');
    expect(d.vault.readLocal(f)).toBe('much-larger-content-here\n');
  }, 180_000);

  it('latest-mtime → the later-edited side wins; both converge', async () => {
    const { d, m } = pair('mtime', { autoMergeFileStrategy: 'latest-mtime' });
    const f = 'mtime.md';
    await seedBoth(d, m, f, 'base\n');
    d.vault.seedLocal(f, 'D-older\n'); await d.sync();
    // M edits AFTER D's sync, so M's local mtime is the latest of the two → M wins.
    m.vault.seedLocal(f, 'M-newer\n');
    await m.sync();
    await d.sync();
    const mC = m.vault.readLocal(f)!;
    expect(mC).toBe(await remote(f));     // converged
    expect(d.vault.readLocal(f)).toBe(mC); // both sides identical
    expect(mC).toBe('M-newer\n');          // the later edit won (no data loss of the winner)
  }, 180_000);
});
