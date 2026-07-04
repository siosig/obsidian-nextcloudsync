// Layer B — multi-device frontmatter merge hardening (feature 043), live server.
// Reproduces the two situations the user asked to cover, end-to-end against a real Nextcloud:
//   (1) PC-A and PC-B each edit the SAME note's frontmatter/body separately → merge.
//   (2) PC-A edits locally + a server-side program rewrites the remote frontmatter out of band
//       (the real reported bug: base [1,2,3] → server [2,3,4] must land at [2,3,4], not union
//       [1,2,3,4]) → PC-A syncs.
// Invariants asserted across every case: the resolved `---` frontmatter block NEVER contains a
// conflict-marker line, list fields honour deletions (no union resurrection, no near-duplicate
// growth), scalar conflicts fall to the existing policy, and a further no-edit sync converges with
// no churn / no marker growth / no tag growth (self-healing).
//
// D = desktop (defaults). M = iPhone: periodic sync + watch-on-change OFF (trigger settings only;
// the test drives every sync manually, exactly like a manual iPhone sync).
import { describeLive } from '../support/env';
import { setupWorkspace } from '../support/workspace';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { makeDevice } from '../support/engineDevice';
import { decodeBuf, textBuf } from '../support/helpers';

/** Extract the leading `---\n…\n---` frontmatter block (empty when the note has none). */
function fmBlock(content: string): string {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  return m ? m[0] : '';
}

/** True when any line in `s` is a plugin conflict-marker line. */
function hasMarkerLines(s: string): boolean {
  return /^(?:<<<<<<<|=======|>>>>>>>)/m.test(s);
}

/** The list items under a `tags:` key in a frontmatter block (block style), normalized-string form. */
function tagsIn(content: string): string[] {
  const lines = fmBlock(content).split(/\r?\n/);
  const start = lines.findIndex((l) => /^tags:\s*$/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) break;
    const m = lines[i].match(/^\s+-\s*'?"?([^'"\n]+?)'?"?\s*$/);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

describeLive('Layer B — frontmatter merge hardening (043) across D/M + server rewrite', (getEnv) => {
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

  // ── FM-B1-1: both devices edit tags — deletion propagates, both additions kept, no markers ─────
  it('[SPEC:FM-B1-1] D deletes+adds a tag while M adds a tag → base-aware set merge (deletion propagates, no marker, converges)', async () => {
    const env = getEnv();
    const d = makeDevice(env, ws.remoteBase, 'D-desktop');
    const m = makeDevice(env, ws.remoteBase, 'M-iphone', { syncIntervalMinutes: 0, watchOnChangeEnabled: false });
    const F = 'fm-b1-1.md';
    d.vault.seedLocal('anchor.md', 'anchor');

    // Baseline: tags [keep, dropme] on both devices.
    d.vault.seedLocal(F, '---\ntags:\n  - keep\n  - dropme\n---\nBody\n');
    await d.sync();
    await m.sync();
    expect(tagsIn(m.vault.readLocal(F)!)).toEqual(['keep', 'dropme']);

    // D: delete `dropme`, add `addd` → [keep, addd]; sync → remote holds D's set.
    d.vault.seedLocal(F, '---\ntags:\n  - keep\n  - addd\n---\nBody\n');
    await d.sync();

    // M: independently add `addm` (keeps dropme) → [keep, dropme, addm]; then sync → 3-way set merge.
    m.vault.seedLocal(F, '---\ntags:\n  - keep\n  - dropme\n  - addm\n---\nBody\n');
    await m.sync();

    const merged = m.vault.readLocal(F)!;
    // Set semantics: dropme deleted by D (propagates even though M kept it); both additions survive.
    expect(tagsIn(merged).sort()).toEqual(['addd', 'addm', 'keep']);
    expect(hasMarkerLines(fmBlock(merged))).toBe(false);
    // resolveByWrite pushed the merged note → M local == remote this round.
    expect(await remote(F)).toBe(merged);
    expect(m.stateDB.getFile(F)?.isConflicted ?? false).toBe(false);

    // Convergence: another no-edit sync leaves everything byte-stable (no churn / tag growth / markers).
    await m.sync();
    expect(m.vault.readLocal(F)).toBe(merged);
    expect(tagsIn(m.vault.readLocal(F)!).sort()).toEqual(['addd', 'addm', 'keep']);
    // D also converges onto the merged set.
    await d.sync();
    expect(tagsIn(d.vault.readLocal(F)!).sort()).toEqual(['addd', 'addm', 'keep']);
    expect(hasMarkerLines(fmBlock(d.vault.readLocal(F)!))).toBe(false);
  }, 180_000);

  // ── FM-B1-2: both devices change the same scalar → existing policy decides, no markers ─────────
  it('[SPEC:FM-B1-2] D and M change the same frontmatter scalar to different values → existing policy decides, no marker', async () => {
    const env = getEnv();
    const d = makeDevice(env, ws.remoteBase, 'D-desktop');
    const m = makeDevice(env, ws.remoteBase, 'M-iphone', { syncIntervalMinutes: 0, watchOnChangeEnabled: false });
    const F = 'fm-b1-2.md';

    d.vault.seedLocal(F, '---\ntitle: BaseTitle\n---\nBody\n');
    await d.sync();
    await m.sync();

    d.vault.seedLocal(F, '---\ntitle: TitleFromD\n---\nBody\n');
    await d.sync();
    m.vault.seedLocal(F, '---\ntitle: TitleFromM\n---\nBody\n');
    await m.sync();

    const merged = m.vault.readLocal(F)!;
    // Scalar conflict resolved by the existing policy → exactly ONE title survives, never both, never a marker.
    expect(hasMarkerLines(fmBlock(merged))).toBe(false);
    const hasD = merged.includes('TitleFromD');
    const hasM = merged.includes('TitleFromM');
    expect(hasD !== hasM).toBe(true); // exactly one winner
    expect(await remote(F)).toBe(merged);

    // Convergence.
    await m.sync();
    expect(m.vault.readLocal(F)).toBe(merged);
    await d.sync();
    expect(d.vault.readLocal(F)).toBe(merged);
  }, 180_000);

  // ── FM-B1-3: server rewrites tags out of band ([1,2,3]→[2,3,4]); local drifted → set merge ─────
  it('[SPEC:FM-B1-3] a server-side tag rewrite [t1,t2,t3]→[t2,t3,t4] propagates the deletion of t1 (base-aware merge, not union)', async () => {
    const env = getEnv();
    const d = makeDevice(env, ws.remoteBase, 'D-desktop');
    const F = 'fm-b1-3.md';

    // D publishes the base tag set; a base is recorded on this device (feature 038).
    d.vault.seedLocal(F, '---\ntags:\n  - t1\n  - t2\n  - t3\n---\nBody\n');
    await d.sync();
    expect(tagsIn(await remote(F))).toEqual(['t1', 't2', 't3']);

    // D drifts locally (body edit; tags left at base) so the next sync runs the MERGE path, not a plain
    // download — this is the path the union bug used to corrupt.
    d.vault.seedLocal(F, '---\ntags:\n  - t1\n  - t2\n  - t3\n---\nBody edited on D\n');

    // A server-side program rewrites the REMOTE frontmatter out of band: deletes t1, adds t4.
    await baseClient.uploadFile(F, textBuf('---\ntags:\n  - t2\n  - t3\n  - t4\n---\nBody\n'));

    // D syncs → base-aware set merge: base [t1,t2,t3], local [t1,t2,t3], remote [t2,t3,t4].
    await d.sync();
    const merged = d.vault.readLocal(F)!;
    // t1 deleted by the server (local unchanged for it) → gone. t4 added → present. NOT union [t1..t4].
    expect(tagsIn(merged).sort()).toEqual(['t2', 't3', 't4']);
    expect(merged).not.toContain('t1');
    expect(hasMarkerLines(fmBlock(merged))).toBe(false);

    // Convergence: re-sync is a fixed point (no resurrection, no growth, no markers).
    await d.sync();
    expect(tagsIn(d.vault.readLocal(F)!).sort()).toEqual(['t2', 't3', 't4']);
    expect(hasMarkerLines(fmBlock(d.vault.readLocal(F)!))).toBe(false);
  }, 180_000);

  // ── FM-B1-4: server rewrite in a "strict regex breaks" shape (CRLF + trailing-space fences) ─────
  it('[SPEC:FM-B1-4] a server rewrite with CRLF + trailing-space fences never lands a marker inside frontmatter', async () => {
    const env = getEnv();
    const d = makeDevice(env, ws.remoteBase, 'D-desktop');
    const F = 'fm-b1-4.md';

    d.vault.seedLocal(F, '---\ntags:\n  - a\n---\nBody\n');
    await d.sync();

    // Local drift is in the FRONTMATTER (add tag z), body untouched — so the merge path runs but the
    // body has no spurious conflict (only the frontmatter diverges structurally).
    d.vault.seedLocal(F, '---\ntags:\n  - a\n  - z\n---\nBody\n');
    // Server rewrites with CRLF and trailing spaces after the fences — the shape the OLD greedy regex
    // failed to parse, dropping the whole file to diff3 and burying the frontmatter inside markers.
    await baseClient.uploadFile(F, textBuf('--- \r\ntags:\r\n  - a\r\n  - b\r\n--- \r\nBody\r\n'));

    await d.sync();
    const merged = d.vault.readLocal(F)!;
    // getFrontMatterInfo tolerates CRLF/trailing spaces → frontmatter resolved STRUCTURALLY, so NO
    // conflict-marker line lands inside (or anywhere near) the frontmatter block.
    expect(hasMarkerLines(fmBlock(merged))).toBe(false);
    expect(merged).not.toContain('<<<<<<< LOCAL');
    // Structural set merge across the CRLF/trailing-space rewrite: base [a] + local +z + remote +b.
    expect(tagsIn(merged).sort()).toEqual(['a', 'b', 'z']);

    await d.sync();
    expect(hasMarkerLines(fmBlock(d.vault.readLocal(F)!))).toBe(false);
    expect(tagsIn(d.vault.readLocal(F)!).sort()).toEqual(['a', 'b', 'z']);
  }, 180_000);

  // ── FM-B1-5: explicit self-heal — after a set-merge, repeated syncs never churn/grow ────────────
  it('[SPEC:FM-B1-5] after a frontmatter set merge, repeated no-edit syncs converge (no churn, no marker growth, no tag growth)', async () => {
    const env = getEnv();
    const d = makeDevice(env, ws.remoteBase, 'D-desktop');
    const m = makeDevice(env, ws.remoteBase, 'M-iphone', { syncIntervalMinutes: 0, watchOnChangeEnabled: false });
    const F = 'fm-b1-5.md';

    d.vault.seedLocal(F, '---\ntags:\n  - keep\n  - dropme\n---\nBody\n');
    await d.sync();
    await m.sync();
    d.vault.seedLocal(F, '---\ntags:\n  - keep\n  - addd\n---\nBody\n');
    await d.sync();
    m.vault.seedLocal(F, '---\ntags:\n  - keep\n  - dropme\n  - addm\n---\nBody\n');
    await m.sync();

    const converged = m.vault.readLocal(F)!;
    const convergedTags = tagsIn(converged).sort();

    // Three further no-edit syncs on both devices: content must be a byte-stable fixed point.
    for (let i = 0; i < 3; i++) {
      await d.sync();
      await m.sync();
      expect(m.vault.readLocal(F)).toBe(converged);         // no churn
      expect(tagsIn(m.vault.readLocal(F)!).sort()).toEqual(convergedTags); // no tag growth
      expect(hasMarkerLines(m.vault.readLocal(F)!)).toBe(false);           // no marker growth
    }
    expect(await remote(F)).toBe(converged);
  }, 240_000);
});
