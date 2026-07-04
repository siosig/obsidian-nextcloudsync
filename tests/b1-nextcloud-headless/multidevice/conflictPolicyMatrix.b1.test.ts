// Layer B — full matrix of conflict-resolution STRATEGIES across TWO devices (live server).
//
// Feature 037 replaced the old 2×3×4 policy cross-product with a single per-type strategy. This
// matrix exercises every strategy on its OWN file and asserts the resolved outcome plus
// convergence/stability on a follow-up sync. The conflict is FRONTMATTER-ONLY (identical body,
// diverging `title`) with EQUAL-LENGTH documents, so each strategy has one deterministic outcome
// derived from ConflictResolver.decide (unit-verified in tests/a-no-nextcloud):
//   - Auto Merge File (case-*.md, extension in autoMergeFileTypes):
//       merge         → both titles diverge from base, but a frontmatter scalar conflict is resolved
//                       by frontmatterScalarConflictPolicy (default latest-mtime), never text-diffed
//                       (feature 043, HFM-6/HFM-9) ⇒ M (newer) wins cleanly, NO markers
//       biggest-size  → equal length ⇒ tie ⇒ no-op (both untouched, not conflicted, FR-009)
//       latest-mtime  → M syncs last (newer) ⇒ M wins
//       local-win     → M (the resolving device's local copy)
//       remote-win    → D
//   - Other File (case-*.md with an EMPTY autoMergeFileTypes ⇒ everything is Other File):
//       biggest-size / latest-mtime / local-win / remote-win as above (no merge for Other File)
//
// Manual only (pnpm test:b1 -- conflictPolicyMatrix); skips without .env NEXTCLOUD_*.
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice } from '../support/engineDevice';
import { decodeBuf } from '../support/helpers';
import { DavSyncSettings, SyncStrategy } from '../../../src/types';

type Winner = 'M' | 'D' | 'markers' | 'tie';

interface Combo { i: number; kind: 'auto' | 'other'; strategy: SyncStrategy; winner: Winner; }

function autoWinner(s: SyncStrategy): Winner {
  switch (s) {
    case 'merge': return 'M';              // 043 (HFM-6/9): frontmatter scalar conflict → scalar policy (default latest-mtime) picks newer side (M), clean, no markers
    case 'biggest-size': return 'tie';     // equal-length docs ⇒ size tie ⇒ no-op
    case 'latest-mtime': return 'M';       // M resolves last ⇒ newer
    case 'local-win': return 'M';
    case 'remote-win': return 'D';
  }
}

const AUTO_STRATEGIES: SyncStrategy[] = ['merge', 'biggest-size', 'latest-mtime', 'local-win', 'remote-win'];
const OTHER_STRATEGIES: Exclude<SyncStrategy, 'merge'>[] = ['biggest-size', 'latest-mtime', 'local-win', 'remote-win'];

const COMBOS: Combo[] = (() => {
  const out: Combo[] = [];
  let i = 0;
  for (const strategy of AUTO_STRATEGIES) out.push({ i: i++, kind: 'auto', strategy, winner: autoWinner(strategy) });
  for (const strategy of OTHER_STRATEGIES) out.push({ i: i++, kind: 'other', strategy, winner: autoWinner(strategy) });
  return out;
})();

// Frontmatter-only conflict: same body, diverging `title`, EQUAL length on both sides.
const fileFor = (c: Combo): string => `case-${c.i}.md`;
const doc = (title: string): string => `---\ntitle: ${title}\n---\n\nshared body line\n`;
const BASE = doc('base');
const D_DOC = doc('frm-D'); // equal length to M_DOC
const M_DOC = doc('frm-M');

describeLive('Layer B — conflict-resolution strategy matrix (2 devices, feature 037)', (getEnv) => {
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
    'combo %#: kind=$kind strategy=$strategy → winner=$winner',
    async (c) => {
      const env = getEnv();
      const path = fileFor(c);
      const over: Partial<DavSyncSettings> =
        c.kind === 'auto'
          ? { autoMergeFileTypes: ['md'], autoMergeFileStrategy: c.strategy }
          : { autoMergeFileTypes: [], otherFileStrategy: c.strategy as Exclude<SyncStrategy, 'merge'> };
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

      // M makes its OWN divergent frontmatter edit, then syncs → conflict resolved per the strategy.
      m.vault.seedLocal(path, M_DOC);
      await m.sync();

      const mLocal = m.vault.readLocal(path)!;
      const rRemote = await remote(path);
      const isConflicted = m.stateDB.getFile(path)?.isConflicted ?? false;

      // ── Assert the resolved outcome for this strategy ──────────────────────────────────────
      if (c.winner === 'M') {
        expect(mLocal).toContain('frm-M');
        expect(mLocal).not.toContain('frm-D');
        expect(rRemote).toBe(mLocal);          // converged: remote == local
        expect(isConflicted).toBe(false);
      } else if (c.winner === 'D') {
        expect(mLocal).toContain('frm-D');
        expect(mLocal).not.toContain('frm-M');
        expect(rRemote).toBe(mLocal);
        expect(isConflicted).toBe(false);
      } else if (c.winner === 'markers') {
        // Conflict markers / #conflict tag: BOTH versions preserved (no data loss), pushed to remote.
        expect(mLocal === rRemote).toBe(true);
        expect(/^<<<<<<< /m.test(mLocal) || mLocal.includes('#conflict')).toBe(true);
        expect(mLocal).toContain('frm-M');
        expect(mLocal).toContain('frm-D');
        expect(isConflicted).toBe(true);
      } else {
        // 'tie' (size tie under biggest-size): both sides UNTOUCHED, NOT conflicted, not an error.
        expect(mLocal).toBe(M_DOC);            // local unchanged
        expect(rRemote).toBe(D_DOC);           // remote unchanged
        expect(isConflicted).toBe(false);      // FR-009: a tie is a success, not a held conflict
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
