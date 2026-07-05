// Shared driver for the feature-047 conflict-option matrix, split into one test FILE per
// frontmatterStrategy so jest can run them in PARALLEL (`--maxWorkers`). Each file gets its own
// isolated live workspace, so concurrent files never collide on the shared server.
//
// Each combo uses a note whose frontmatter AND body both diverge from base, crafted so every strategy
// has ONE deterministic outcome (M = the resolving device syncs last ⇒ newer; D's frontmatter block is
// larger; M's body is larger):
//   frontmatter: merge → title=M (latest-mtime scalar tiebreak) + tags UNION {t0,tagM,tagD};
//               latest-mtime/local-win → M's whole fm block ({t0,tagM});
//               remote-win/biggest-size → D's whole fm block ({t0,tagD}).
//   body:       merge → conflict markers (both bodies kept, conflicted);
//               latest-mtime/local-win/biggest-size → M's body; remote-win → D's body.
//   conflicted: true ONLY when the body strategy is merge and the body conflicts.
import { describeLive } from './env';
import { setupWorkspace } from './workspace';
import { cleanupWorkspace, IsolatedWorkspace } from './isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice } from './engineDevice';
import { decodeBuf } from './helpers';
import { DavSyncSettings, SyncStrategy } from '../../../src/types';

type Side = 'M' | 'D';
const AUTO_BODY: SyncStrategy[] = ['merge', 'biggest-size', 'latest-mtime', 'local-win', 'remote-win'];
const OTHER_BODY: Exclude<SyncStrategy, 'merge'>[] = ['biggest-size', 'latest-mtime', 'local-win', 'remote-win'];

const BASE = '---\ntitle: titleBase\ntags:\n  - t0\n---\nbody base\n';
const D_DOC = '---\ntitle: titleDDDD\ntags:\n  - t0\n  - tagD\n---\nbody D\n';
const M_DOC = '---\ntitle: titleM\ntags:\n  - t0\n  - tagM\n---\nbody MMMMMMMMMM\n';

function fmBlock(content: string): string {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  return m ? m[0] : '';
}
const hasMarkers = (s: string): boolean => /^(?:<<<<<<<|=======|>>>>>>>)/m.test(s);
const fmWholeSide = (fm: SyncStrategy): Side => (fm === 'remote-win' || fm === 'biggest-size' ? 'D' : 'M');
const bodyWholeSide = (body: SyncStrategy): Side => (body === 'remote-win' ? 'D' : 'M');

interface Cell { kind: 'auto' | 'other'; body: SyncStrategy; }

/** Register the full body-strategy sweep for one frontmatterStrategy as a live describe block. */
export function defineConflictMatrix(fm: SyncStrategy): void {
  const cells: Cell[] = [
    ...AUTO_BODY.map((body): Cell => ({ kind: 'auto', body })),
    ...OTHER_BODY.map((body): Cell => ({ kind: 'other', body })),
  ];

  describeLive(`Layer B — conflict matrix, frontmatterStrategy=${fm} (feature 047)`, (getEnv) => {
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

    it.each(cells.map((c, i) => ({ ...c, i })))(
      `fm=${fm} kind=$kind body=$body`,
      async (c) => {
        const env = getEnv();
        const path = `case-${fm}-${c.i}.md`;
        const over: Partial<DavSyncSettings> =
          c.kind === 'auto'
            ? { autoMergeFileTypes: ['md'], autoMergeFileStrategy: c.body, frontmatterStrategy: fm }
            : { autoMergeFileTypes: [], otherFileStrategy: c.body as Exclude<SyncStrategy, 'merge'>, frontmatterStrategy: fm };
        const d = makeDevice(env, ws.remoteBase, `D-${fm}-${c.i}`, over);
        const m = makeDevice(env, ws.remoteBase, `M-${fm}-${c.i}`, over);

        // Baseline: in sync (also seeds the merge base for the note — FR-015).
        d.vault.seedLocal(path, BASE);
        await d.sync();
        await m.sync();
        expect(m.vault.readLocal(path)).toBe(BASE);

        // D edits frontmatter + body → remote = D's version.
        d.vault.seedLocal(path, D_DOC);
        await d.sync();
        expect(await remote(path)).toBe(D_DOC);

        // M makes its OWN divergent edit, then syncs → conflict resolved per (fm, body) independently.
        m.vault.seedLocal(path, M_DOC);
        await m.sync();

        const mLocal = m.vault.readLocal(path)!;
        const rRemote = await remote(path);
        const isConflicted = m.stateDB.getFile(path)?.isConflicted ?? false;
        const fmb = fmBlock(mLocal);

        // Frontmatter half: never carries markers; resolved by frontmatterStrategy.
        expect(hasMarkers(fmb)).toBe(false);
        if (fm === 'merge') {
          expect(fmb).toContain('title: titleM');
          expect(fmb).toContain('tagM');
          expect(fmb).toContain('tagD');
        } else if (fmWholeSide(fm) === 'M') {
          expect(fmb).toContain('title: titleM');
          expect(fmb).toContain('tagM');
          expect(fmb).not.toContain('tagD');
        } else {
          expect(fmb).toContain('title: titleDDDD');
          expect(fmb).toContain('tagD');
          expect(fmb).not.toContain('tagM');
        }

        // Body half: resolved by the body strategy, independently of the frontmatter.
        const bodyPart = mLocal.slice(fmb.length);
        if (c.body === 'merge') {
          expect(hasMarkers(bodyPart)).toBe(true);
          expect(bodyPart).toContain('body D');
          expect(bodyPart).toContain('body MMMMMMMMMM');
          expect(isConflicted).toBe(true);
        } else {
          expect(hasMarkers(bodyPart)).toBe(false);
          if (bodyWholeSide(c.body) === 'M') expect(bodyPart).toContain('body MMMMMMMMMM');
          else expect(bodyPart).toContain('body D');
          expect(isConflicted).toBe(false);
        }

        // Converged, then stable on a second sync.
        expect(rRemote).toBe(mLocal);
        await m.sync();
        expect(m.vault.readLocal(path)).toBe(mLocal);
        expect(await remote(path)).toBe(rRemote);
        const baseName = path.replace(/\.md$/, '');
        const copies = m.vault.vault.getFiles().filter((f) => f.path === path || f.path.startsWith(`${baseName} (conflicted copy`)).length;
        expect(copies).toBe(1);
      },
      120_000,
    );
  });
}
