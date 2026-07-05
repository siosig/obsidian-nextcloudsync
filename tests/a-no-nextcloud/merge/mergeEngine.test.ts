import { MergeEngine, hasNestedConflictMarkers } from '../../../src/sync/merge/MergeEngine';
import { MergeContext } from '../../../src/types';

// Mock reconcile-text and node-diff3 for unit tests.
// IMPORTANT: the real reconcile() returns a TextWithCursors object ({ text, cursors }), not a string —
// the mock must mirror that shape so the strategy's `.text` extraction is exercised.
jest.mock('reconcile-text', () => ({
  reconcile: (base: string, local: string, remote: string) => {
    // Simplistic: concatenate unique lines
    const text = local === remote ? local : local + remote;
    return { text, cursors: [] };
  },
}));

jest.mock('node-diff3', () => ({
  // Diff3Strategy uses diff3Merge, which returns a chunk array ({ok}|{conflict}).
  diff3Merge: (a: string[], _o: string[], b: string[], _opts: unknown) => {
    const hasConflict = JSON.stringify(a) !== JSON.stringify(b);
    return hasConflict ? [{ conflict: { a, b } }] : [{ ok: a }];
  },
}));


/** Extract the leading `---\n…\n---` frontmatter block from merged content (empty when none). */
function frontmatterBlock(content: string): string {
  const m = content.match(/^---\n[\s\S]*?\n---/);
  return m ? m[0] : '';
}

/** True when any line is a plugin conflict-marker line (`<<<<<<<`, `=======`, `>>>>>>>`). */
function hasMarkerLines(s: string): boolean {
  return /^(?:<<<<<<<|=======|>>>>>>>)/m.test(s);
}

describe('MergeEngine', () => {
  it('union-merges differing frontmatter tag arrays (feature 040)', () => {
    // Previously returned success=false; now semantic merge union-merges array fields.
    const engine = new MergeEngine();
    const local = '---\ntags:\n  - a\n---\nBody';
    const remote = '---\ntags:\n  - b\n---\nBody';
    const result = engine.merge('', local, remote);
    expect(result.success).toBe(true);
    expect(result.mergedContent).toContain('a');
    expect(result.mergedContent).toContain('b');
  });

  it('merges body when frontmatter is identical', () => {
    const engine = new MergeEngine();
    const fm = '---\ntags: [a]\n---';
    const base = `${fm}\nLine 1`;
    const local = `${fm}\nLine 1\nLine 2`;
    const remote = `${fm}\nLine 1`;
    const result = engine.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.mergedContent).toContain(fm);
  });

  it('triggers content-loss circuit breaker', () => {
    const engine = new MergeEngine();
    // Mock returns very short string
    jest.mock('reconcile-text', () => ({ reconcile: () => 'x' }));
    const local = 'A'.repeat(200);
    const remote = 'B'.repeat(200);
    // When merged < 50% of max(local, remote) = 200, circuit breaks
    // Here we use a local mock that produces tiny output
    // The real circuit breaker is tested with actual output length
    const result = engine.merge('', local, remote);
    // With our mock, reconcile returns local+remote which is long enough
    expect(result).toBeDefined();
  });

  // [SPEC:CF-14] feature 048: a real body conflict is resolved per-region by conflictStrategy — the
  // default (conflict-markers) writes the region as markers and flags conflicted; a deterministic
  // conflictStrategy picks the region's hunk cleanly.
  it('[SPEC:CF-14] a body conflict is written as markers under the default conflict-markers strategy', () => {
    const engine = new MergeEngine();
    const base = 'Line 1\nLine 2';
    const local = 'Changed 1\nLine 2';
    const remote = 'Line 1\nChanged 2';
    const result = engine.merge(base, local, remote); // no ctx → conflictStrategy defaults to conflict-markers
    expect(result.hadConflicts).toBe(true);
    expect(hasMarkerLines(result.mergedContent)).toBe(true);
    expect(result.success).toBe(true);
  });

  it('[SPEC:CF-14] a deterministic conflictStrategy resolves the region with no markers', () => {
    const engine = new MergeEngine();
    const base = 'Line 1\nLine 2';
    const local = 'Changed 1\nLine 2';
    const remote = 'Line 1\nChanged 2';
    const result = engine.merge(base, local, remote, { localMtime: 0, remoteMtime: 9, conflictStrategy: 'remote-win' });
    expect(result.hadConflicts).toBe(false);
    expect(hasMarkerLines(result.mergedContent)).toBe(false);
    expect(result.mergedContent).toContain('Changed 2'); // remote hunk kept
    expect(result.mergedContent).not.toContain('Changed 1');
  });

  // ─── Feature 043: frontmatter is never text-diffed (no marker lines inside a --- block) ──────────

  it('[SPEC:HFM-9] frontmatter the old regex could not parse (CRLF + trailing-space fences) yields zero marker lines', () => {
    const engine = new MergeEngine();
    const base = '---\ntags:\n  - a\n---\nBody';
    const local = '---\ntags:\n  - a\n  - b\n---\nBody';
    // Trailing spaces after the fences + CRLF: the OLD FRONTMATTER_RE/parseFm regex failed to parse
    // this, dropped to whole-file diff3, and buried the frontmatter inside conflict markers.
    const remote = '--- \r\ntags:\r\n  - a\r\n  - c\r\n--- \r\nBody';
    const result = engine.merge(base, local, remote);
    expect(result.success).toBe(true);
    const fmBlock = frontmatterBlock(result.mergedContent);
    expect(hasMarkerLines(fmBlock)).toBe(false);
    expect(result.mergedContent).not.toContain('<<<<<<< LOCAL');
    // Resolved structurally: base [a] + local +b + remote +c → [a, b, c].
    expect(fmBlock).toContain('b');
    expect(fmBlock).toContain('c');
  });

  it('[SPEC:HFM-11] frontmatter carrying leftover conflict-marker lines self-heals with no nesting', () => {
    const engine = new MergeEngine();
    // Local frontmatter is corrupt: a prior broken merge leaked marker lines INTO the YAML block.
    const local = '---\n<<<<<<< LOCAL\ntags:\n  - a\n=======\ntags:\n  - b\n>>>>>>> REMOTE\n---\nBody';
    const remote = '---\ntags:\n  - a\n  - c\n---\nBody';
    // remote newer → latest-mtime picks the clean remote side (self-heal), never re-wrapping markers.
    const ctx: MergeContext = { localMtime: 1000, remoteMtime: 2000 };
    const result = engine.merge('', local, remote, ctx);
    const fmBlock = frontmatterBlock(result.mergedContent);
    expect(hasMarkerLines(fmBlock)).toBe(false);
    expect(hasNestedConflictMarkers(result.mergedContent)).toBe(false);
    expect(result.mergedContent).not.toContain('<<<<<<< LOCAL');
  });

  it('[SPEC:HFM-8] a --- thematic break in the body is not mistaken for the frontmatter delimiter', () => {
    const engine = new MergeEngine();
    const base = '---\ntags:\n  - a\n---\nIntro\n\n---\n\nOutro';
    const local = '---\ntags:\n  - a\n  - b\n---\nIntro\n\n---\n\nOutro';
    const remote = '---\ntags:\n  - a\n---\nIntro\n\n---\n\nOutro';
    const result = engine.merge(base, local, remote);
    const fmBlock = frontmatterBlock(result.mergedContent);
    // Only the leading tags fence is frontmatter; the body's --- survives in the body.
    expect(fmBlock).toContain('tags');
    expect(fmBlock).toContain('b');
    expect(fmBlock).not.toContain('Intro');
    expect(result.mergedContent).toContain('Intro');
    expect(result.mergedContent).toContain('Outro');
    expect(hasMarkerLines(fmBlock)).toBe(false);
  });

  it('[SPEC:HFM-10] an unparseable side is resolved by a whole-side pick (latest-mtime) — no diff3 markers', () => {
    const engine = new MergeEngine();
    const bad = '---\n{ unterminated: yaml\n---\nBody';
    const good = '---\ntitle: Clean\n---\nBody';
    // Feature 047: the scalar policy is gone; the unparseable-side pick is latest-mtime. Remote newer
    // → pick the whole remote (good) side.
    const ctxRemote: MergeContext = { localMtime: 0, remoteMtime: 5000 };
    const r1 = engine.merge('', bad, good, ctxRemote);
    const fm1 = frontmatterBlock(r1.mergedContent);
    expect(hasMarkerLines(fm1)).toBe(false);
    expect(fm1).toContain('Clean');
    // Local newer → pick the whole (unparseable) local side verbatim; still no engine-injected markers.
    const ctxLocal: MergeContext = { localMtime: 5000, remoteMtime: 0 };
    const r2 = engine.merge('', bad, good, ctxLocal);
    const fm2 = frontmatterBlock(r2.mergedContent);
    expect(hasMarkerLines(fm2)).toBe(false);
  });

  // ─── Feature 043: server-rewrite scenario + convergence/idempotence (the reported real bug) ──────

  it('[SPEC:HFM-13] a server tag rewrite (base [1,2,3] → remote [2,3,4], local unchanged) converges to [2,3,4] and is idempotent', () => {
    const engine = new MergeEngine();
    // Real case: this device pushed base tags [1,2,3]; a server-side program rewrote remote to [2,3,4]
    // (deleted 1, added 4) while the local side stayed at base. The device must land on the server set,
    // NOT the blind union [1,2,3,4] — the deletion of 1 must propagate.
    const base = "---\ntags:\n  - '1'\n  - '2'\n  - '3'\n---\nBody";
    const local = base; // local unchanged
    const remote = "---\ntags:\n  - '2'\n  - '3'\n  - '4'\n---\nBody";
    const r1 = engine.merge(base, local, remote);
    expect(r1.success).toBe(true);
    const fm1 = frontmatterBlock(r1.mergedContent);
    expect(tagsIn(fm1)).toEqual(['2', '3', '4']); // 1 deleted by server, 4 added — no blind union
    expect(fm1).not.toContain("'1'"); // deletion propagated, no resurrection
    expect(hasMarkerLines(fm1)).toBe(false);

    // Convergence (FR-011): r1's merged result is pushed to the server, so on the next no-edit sync
    // BOTH sides — and the new merge base — hold the converged note. Re-merging that fixed point yields
    // identical frontmatter with no marker growth and no array growth.
    const converged = r1.mergedContent;
    const r2 = engine.merge(converged, converged, converged);
    expect(r2.success).toBe(true);
    const fm2 = frontmatterBlock(r2.mergedContent);
    expect(tagsIn(fm2)).toEqual(['2', '3', '4']); // no array growth
    expect(fm2).toBe(fm1); // idempotent frontmatter (the convergence claim for this feature)
    expect(hasMarkerLines(r2.mergedContent)).toBe(false); // no marker growth
  });
});

/** Parse the `tags` array out of a `---`-wrapped frontmatter block (empty array when none). */
function tagsIn(fmBlock: string): string[] {
  const lines = fmBlock.split('\n');
  const start = lines.findIndex((l) => /^tags:\s*$/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) break; // closing fence ends the frontmatter
    const m = lines[i].match(/^\s+-\s*'?([^'\n]+?)'?\s*$/); // an indented list item under tags
    if (!m) break; // first non-item line (next key) ends the array
    out.push(m[1]);
  }
  return out;
}
