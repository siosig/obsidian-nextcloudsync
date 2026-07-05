// Shared driver for the feature-048 two-level conflict matrix, split into one test FILE per
// frontmatterStrategy so jest can run them in PARALLEL (`--maxWorkers`). Each file gets its own
// isolated live workspace, so concurrent files never collide on the shared server.
//
// Feature 048: a markdown note's frontmatter is resolved by `frontmatterStrategy`, its body by
// `autoMergeFileStrategy` (always — md is special-cased), and a part a `merge` primary cannot
// auto-resolve is decided by `conflictStrategy`. This sweep fixes autoMergeFileStrategy=merge (so the
// body genuinely conflicts) and varies conflictStrategy over its five values. The note diverges in both
// halves against a real base: frontmatter title clash + tags union; body same line changed on both
// sides. M is the resolving device (syncs last ⇒ newer); M's body line is larger; D is remote.
import { describeLive } from './env';
import { setupWorkspace } from './workspace';
import { cleanupWorkspace, IsolatedWorkspace } from './isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice } from './engineDevice';
import { decodeBuf } from './helpers';
import { ConflictStrategy, DavSyncSettings, SyncStrategy } from '../../../src/types';

const CONFLICT_STRATEGIES: ConflictStrategy[] = ['conflict-markers', 'biggest-size', 'latest-mtime', 'local-win', 'remote-win'];

const BASE = '---\ntitle: titleBase\ntags:\n  - t0\n---\nshared\nBASE LINE\n';
const D_DOC = '---\ntitle: titleD\ntags:\n  - t0\n  - tagD\n---\nshared\nD LINE\n';
const M_DOC = '---\ntitle: titleM\ntags:\n  - t0\n  - tagM\n---\nshared\nMMMM LINE\n';

function fmBlock(content: string): string {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  return m ? m[0] : '';
}
const hasMarkers = (s: string): boolean => /^(?:<<<<<<<|=======|>>>>>>>)/m.test(s);

/** Register the conflictStrategy sweep for one frontmatterStrategy as a live describe block. */
export function defineConflictMatrix(frontmatterStrategy: SyncStrategy): void {
  describeLive(`Layer B — conflict-strategy sweep, frontmatterStrategy=${frontmatterStrategy} (feature 048)`, (getEnv) => {
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

    it.each(CONFLICT_STRATEGIES.map((cs, i) => ({ cs, i })))(
      `fm=${frontmatterStrategy} conflictStrategy=$cs`,
      async (c) => {
        const env = getEnv();
        const path = `case-${frontmatterStrategy}-${c.i}.md`;
        const over: Partial<DavSyncSettings> = {
          autoMergeFileTypes: [], // md is special-cased regardless of the list — proves FR-002
          autoMergeFileStrategy: 'merge',
          frontmatterStrategy,
          conflictStrategy: c.cs,
        };
        const d = makeDevice(env, ws.remoteBase, `D-${frontmatterStrategy}-${c.i}`, over);
        const m = makeDevice(env, ws.remoteBase, `M-${frontmatterStrategy}-${c.i}`, over);

        // Baseline: in sync (seeds the merge base for the note — FR-015).
        d.vault.seedLocal(path, BASE);
        await d.sync();
        await m.sync();
        expect(m.vault.readLocal(path)).toBe(BASE);

        // D edits frontmatter + body → remote = D's version.
        d.vault.seedLocal(path, D_DOC);
        await d.sync();
        expect(await remote(path)).toBe(D_DOC);

        // M makes its own divergent edit, then syncs → 2-level resolution.
        m.vault.seedLocal(path, M_DOC);
        await m.sync();

        const mLocal = m.vault.readLocal(path)!;
        const rRemote = await remote(path);
        const isConflicted = m.stateDB.getFile(path)?.isConflicted ?? false;
        const fmb = fmBlock(mLocal);
        const body = mLocal.slice(fmb.length);

        // Frontmatter never carries markers.
        expect(hasMarkers(fmb)).toBe(false);

        // Body: conflict-markers → markers + conflicted; else the winning side's line, no markers.
        if (c.cs === 'conflict-markers') {
          expect(hasMarkers(body)).toBe(true);
          expect(body).toContain('D LINE');
          expect(body).toContain('MMMM LINE');
          expect(isConflicted).toBe(true);
        } else {
          expect(hasMarkers(body)).toBe(false);
          const remoteWins = c.cs === 'remote-win';
          expect(body).toContain(remoteWins ? 'D LINE' : 'MMMM LINE');
          expect(isConflicted).toBe(false);
          expect(body).toContain('shared'); // non-conflicting shared line survives
        }

        // Frontmatter title (only a scalar clash when frontmatterStrategy=merge):
        if (frontmatterStrategy === 'merge') {
          if (c.cs === 'remote-win') expect(fmb).toContain('title: titleD');
          else expect(fmb).toContain('title: titleM'); // markers→latest(M) / local/latest/biggest→M
          expect(fmb).toContain('tagD'); // tags always union regardless of conflictStrategy
          expect(fmb).toContain('tagM');
        }

        // Converged, then stable on a second sync.
        expect(rRemote).toBe(mLocal);
        await m.sync();
        expect(m.vault.readLocal(path)).toBe(mLocal);
        expect(await remote(path)).toBe(rRemote);
      },
      120_000,
    );
  });
}
