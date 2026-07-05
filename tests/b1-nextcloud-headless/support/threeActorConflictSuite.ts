// Feature 051 — abnormal (conflict) matrix, defined once per pair (D↔M / D↔N / M↔N) so jest runs the
// three pairs in PARALLEL files. For each pair it sweeps the degeneracy-reduced strategy space:
//   - txt body conflict  × conflictStrategy {conflict-markers, local-win, remote-win}
//   - md frontmatter clash × frontmatterStrategy {merge, remote-win, local-win} (body identical)
//   - delete-vs-modify   → convergence (self-healing), winner left to the strategy
// Cluster-only: N needs SSH + occ. describeCluster() SKIPS the whole suite (visible in the report,
// never a silent pass) when the cluster env is absent, so the default `pnpm test:b1` stays green.
// Run the matrix via `pnpm test:b1:cluster` (which exports the N-actor env).
import { describeCluster } from './env';
import { setupWorkspace } from './workspace';
import { cleanupWorkspace, IsolatedWorkspace } from './isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeThreeActors, runDivergentEdit, PairCfg } from './threeActor';
import { ConflictStrategy, DavSyncSettings, SyncStrategy } from '../../../src/types';

const hasMarkers = (s: string | null): boolean => !!s && /^<<<<<<< LOCAL/m.test(s);
const fmOf = (s: string | null): string => { const m = s?.match(/^---\r?\n[\s\S]*?\r?\n---/); return m ? m[0] : ''; };
// Match a YAML tag as a whole list-item line, so a short tag like `tl` is not falsely found as a
// substring inside another key/value (e.g. `ti(tl)e`). Anchored per-line, whitespace-tolerant.
const hasTag = (s: string, tag: string): boolean => new RegExp(`^\\s*-\\s*${tag}\\s*$`, 'm').test(s);

export function defineThreeActorConflict(cfg: PairCfg): void {
  describeCluster(`Layer B — 3-actor conflict, pair=${cfg.key} (feature 051)`, (getEnv) => {
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

    const actors = (suffix: string, over: Partial<DavSyncSettings>) =>
      makeThreeActors(getEnv(), ws.remoteBase, `${cfg.key}-${suffix}`, over);

    // ── txt body conflict × conflictStrategy (deterministic-by-side values) ──
    const CS: ConflictStrategy[] = ['conflict-markers', 'local-win', 'remote-win'];
    it.each(CS)(`txt body conflict, conflictStrategy=%s`, async (cs) => {
      const a = actors(`txt-${cs}`, { autoMergeFileTypes: ['txt'], autoMergeFileStrategy: 'merge', conflictStrategy: cs });
      // Anchor the conflict with stable first/last lines so diff3 produces a genuine SAME-LINE
      // conflict region (an unanchored single-line change is merged as two separate insertions).
      // Unique path per parametrized case: cs-variants must not share a file, or one case's residual
      // server content / device StateDB base contaminates the next case's 3-way merge (merge-both).
      const { localView, remoteView } = await runDivergentEdit(a, cfg, {
        path: `c-${cs}.txt`, base: 'top\nMID-BASE\nbot\n', localContent: 'top\nMID-LOCAL\nbot\n', remoteContent: 'top\nMID-REMOTE\nbot\n',
      });
      // `local` device is the resolver: its own edit is the LOCAL side; the other actor is REMOTE.
      if (cs === 'conflict-markers') {
        expect(hasMarkers(localView)).toBe(true);
        expect(localView).toContain('LOCAL');
        expect(localView).toContain('REMOTE');
      } else {
        expect(hasMarkers(localView)).toBe(false);
        expect(localView).toContain(cs === 'local-win' ? 'LOCAL' : 'REMOTE');
        expect(localView).not.toContain(cs === 'local-win' ? 'REMOTE' : 'LOCAL');
      }
      expect(remoteView).toBe(localView); // converged: server matches the resolved local content
    }, 120_000);

    // ── md frontmatter clash × frontmatterStrategy (body identical → no body conflict) ──
    const FM: SyncStrategy[] = ['merge', 'remote-win', 'local-win'];
    it.each(FM)(`md frontmatter clash, frontmatterStrategy=%s`, async (fm) => {
      const a = actors(`md-${fm}`, { autoMergeFileStrategy: 'merge', frontmatterStrategy: fm, conflictStrategy: 'remote-win' });
      const base = '---\ntitle: base\ntags:\n  - t0\n---\nbody\n';
      const local = '---\ntitle: LOCAL\ntags:\n  - t0\n  - tl\n---\nbody\n';
      const remote = '---\ntitle: REMOTE\ntags:\n  - t0\n  - tr\n---\nbody\n';
      const { localView, remoteView } = await runDivergentEdit(a, cfg, { path: `c-${fm}.md`, base, localContent: local, remoteContent: remote });
      const fmb = fmOf(localView);
      expect(hasMarkers(fmb)).toBe(false); // frontmatter never carries markers
      // frontmatterStrategy semantics (spec.md §6.2, MergeEngine.resolveFrontmatterBlock):
      //   merge     → semantic 3-way: arrays SET-merge (union tl+tr); the title scalar clash defers to
      //               conflictStrategy (fixed remote-win here) → title REMOTE.
      //   local-win → adopt the WHOLE local frontmatter block verbatim (title LOCAL, tags [t0, tl]);
      //               remote's tr is NOT unioned in ("merge 以外は丸ごと片側採用").
      //   remote-win→ adopt the WHOLE remote frontmatter block verbatim (title REMOTE, tags [t0, tr]).
      if (fm === 'merge') {
        expect(hasTag(fmb, 'tl')).toBe(true);
        expect(hasTag(fmb, 'tr')).toBe(true);
        expect(fmb).toContain('title: REMOTE'); // scalar clash → conflictStrategy=remote-win
      } else if (fm === 'local-win') {
        expect(hasTag(fmb, 'tl')).toBe(true);
        expect(hasTag(fmb, 'tr')).toBe(false);
        expect(fmb).toContain('title: LOCAL');
      } else { // remote-win
        expect(hasTag(fmb, 'tr')).toBe(true);
        expect(hasTag(fmb, 'tl')).toBe(false);
        expect(fmb).toContain('title: REMOTE');
      }
      expect(remoteView).toBe(localView);
    }, 120_000);

    // ── delete-vs-modify → converges (self-healing), all three actors agree ──
    it(`delete-vs-modify converges`, async () => {
      const a = actors(`delvsmod`, { autoMergeFileTypes: ['txt'], autoMergeFileStrategy: 'merge', conflictStrategy: 'remote-win' });
      // remote modifies, local deletes.
      await runDivergentEdit(a, cfg, { path: `dm.txt`, base: 'base\n', localContent: null, remoteContent: 'remote edit\n' });
      await a.converge(4); // extra passes to reach a stable state
      const v = await a.readAll('dm.txt');
      expect(v.D).toBe(v.M);        // devices agree
      expect(v.N).toBe(v.D);        // server agrees with devices (converged, no perpetual conflict)
    }, 120_000);
  });
}
