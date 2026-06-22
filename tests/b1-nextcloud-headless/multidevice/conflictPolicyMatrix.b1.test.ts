// Layer B — full orthogonal matrix of conflict-resolution settings across TWO devices (live server).
//
// Cross-product (2 × 3 × 4 = 24 combinations):
//   - autoMergeEnabled:          On | Off
//   - frontmatterConflictStrategy: conflict | local-wins | remote-wins
//   - conflictFailurePolicy:     error | local-wins | remote-wins | conflict-markers
//
// Each combination runs the same 2-device conflict on its OWN file and asserts the resolved outcome
// plus convergence/stability on a follow-up sync. The conflict is engineered to be FRONTMATTER-ONLY
// (identical body, diverging `title`) so every combination has a single deterministic expected
// outcome derived from spec §6.2/§6.3 (see expectedWinner()).
//
// Notes the matrix surfaces (intentional, spec-consistent degeneracies):
//   - autoMerge=Off ⇒ MergeEngine is skipped, so frontmatterConflictStrategy is a NO-OP (all 3 values
//     behave identically) and conflictFailurePolicy decides directly.
//   - autoMerge=On with frontmatterStrategy ∈ {local-wins, remote-wins} resolves the frontmatter
//     cleanly, so the failure policy never fires (clean auto-merge).
//
// Manual only (pnpm test:b1 -- conflictPolicyMatrix); skips without .env NEXTCLOUD_*.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice } from '../support/engineDevice';
import { decodeBuf } from '../support/helpers';
import { DavSyncSettings } from '../../../src/types';

type AutoMerge = boolean;
type FmStrategy = DavSyncSettings['frontmatterConflictStrategy']; // 'conflict'|'local-wins'|'remote-wins'
type FailPolicy = DavSyncSettings['conflictFailurePolicy'];       // 'error'|'local-wins'|'remote-wins'|'conflict-markers'
type Winner = 'M' | 'D' | 'markers' | 'skip';

const FM_STRATEGIES: FmStrategy[] = ['conflict', 'local-wins', 'remote-wins'];
const FAIL_POLICIES: FailPolicy[] = ['error', 'local-wins', 'remote-wins', 'conflict-markers'];

/**
 * Expected resolution outcome for the frontmatter-only conflict, derived from ConflictResolver.decide:
 * - autoMerge ON: frontmatter local/remote-wins ⇒ clean merge to that side; frontmatter=conflict ⇒
 *   the failure policy decides (error→skip, local→M, remote→D, conflict-markers→markers).
 * - autoMerge OFF: MergeEngine skipped ⇒ failure policy decides directly (frontmatter strategy ignored).
 */
function expectedWinner(autoMerge: AutoMerge, fm: FmStrategy, policy: FailPolicy): Winner {
  if (autoMerge) {
    if (fm === 'local-wins') return 'M';
    if (fm === 'remote-wins') return 'D';
    // fm === 'conflict' → merge has a frontmatter conflict → failure policy:
  }
  switch (policy) {
    case 'local-wins': return 'M';
    case 'remote-wins': return 'D';
    case 'conflict-markers': return 'markers';
    case 'error': default: return 'skip';
  }
}

interface Combo { i: number; autoMerge: AutoMerge; fm: FmStrategy; policy: FailPolicy; winner: Winner; }
const COMBOS: Combo[] = (() => {
  const out: Combo[] = [];
  let i = 0;
  for (const autoMerge of [true, false]) {
    for (const fm of FM_STRATEGIES) {
      for (const policy of FAIL_POLICIES) {
        out.push({ i: i++, autoMerge, fm, policy, winner: expectedWinner(autoMerge, fm, policy) });
      }
    }
  }
  return out;
})();

// Frontmatter-only conflict: same body, diverging `title`.
const fileFor = (c: Combo): string => `case-${c.i}.md`;
const doc = (title: string): string => `---\ntitle: ${title}\n---\n\nshared body line\n`;
const BASE = doc('base');
const D_DOC = doc('from-D');
const M_DOC = doc('from-M');

describeLive('Layer B — conflict-resolution settings matrix (2 devices, 24 combinations)', (getEnv) => {
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

  const remote = (path: string): Promise<string> => baseClient.downloadFile(path).then(decodeBuf);

  it.each(COMBOS)(
    'combo %#: autoMerge=$autoMerge fm=$fm policy=$policy → winner=$winner',
    async (c) => {
      const env = getEnv();
      const path = fileFor(c);
      const over: Partial<DavSyncSettings> = {
        autoMergeEnabled: c.autoMerge,
        frontmatterConflictStrategy: c.fm,
        conflictFailurePolicy: c.policy,
      };
      // Both devices share the conflict-resolution settings; M is the device that resolves on sync.
      const d = makeDevice(env, ws.remoteBase, `D-${c.i}`, over);
      const m = makeDevice(env, ws.remoteBase, `M-${c.i}`, over);

      // Baseline: file exists on both, in sync.
      d.vault.seedLocal(path, BASE);
      await d.sync();
      await m.sync();
      expect(m.vault.readLocal(path)).toBe(BASE);

      // D edits the frontmatter and syncs → remote = D's version.
      d.vault.seedLocal(path, D_DOC);
      await d.sync();
      expect(await remote(path)).toBe(D_DOC);

      // M makes its OWN divergent frontmatter edit, then syncs → conflict resolved per the combo.
      m.vault.seedLocal(path, M_DOC);
      await m.sync();

      const mLocal = m.vault.readLocal(path)!;
      const rRemote = await remote(path);
      const isConflicted = m.stateDB.getFile(path)?.isConflicted ?? false;

      // ── Assert the resolved outcome for this combination ──────────────────────────────────
      if (c.winner === 'M') {
        // Local content wins on BOTH sides (prefer-local or clean frontmatter local-wins).
        expect(mLocal).toContain('from-M');
        expect(mLocal).not.toContain('from-D');
        expect(rRemote).toBe(mLocal);          // converged: remote == local
        expect(isConflicted).toBe(false);
      } else if (c.winner === 'D') {
        expect(mLocal).toContain('from-D');
        expect(mLocal).not.toContain('from-M');
        expect(rRemote).toBe(mLocal);
        expect(isConflicted).toBe(false);
      } else if (c.winner === 'markers') {
        // Conflict markers / #conflict tag: BOTH versions preserved (no data loss), pushed to remote.
        expect(mLocal === rRemote).toBe(true);
        expect(/^<<<<<<< /m.test(mLocal) || mLocal.includes('#conflict')).toBe(true);
        expect(mLocal).toContain('from-M');
        expect(mLocal).toContain('from-D');
        expect(isConflicted).toBe(true);
      } else {
        // 'skip' (failure policy=error): both sides left UNTOUCHED, entry flagged conflicted.
        expect(mLocal).toBe(M_DOC);            // local unchanged
        expect(rRemote).toBe(D_DOC);           // remote unchanged
        expect(mLocal).not.toBe(rRemote);      // still diverged (no data loss either side)
        expect(isConflicted).toBe(true);
      }

      // ── Convergence / stability: a second M sync must not churn (no re-resolution side effects) ──
      await m.sync();
      expect(m.vault.readLocal(path)).toBe(mLocal); // local content stable
      expect(await remote(path)).toBe(rRemote);     // remote content stable
      // No conflict-copy proliferation: this case's file is the only one with its basename.
      const base = path.replace(/\.md$/, '');
      const copies = m.vault.vault.getFiles().filter((f) => f.path === path || f.path.startsWith(`${base} (conflicted copy`)).length;
      expect(copies).toBe(1);
    },
    120_000,
  );
});
