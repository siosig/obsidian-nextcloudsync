// Diff3Strategy against the REAL node-diff3 library (no mock) — proves the F4 fix:
// the strategy must consume diff3Merge's MergeRegion[] ({ok}|{conflict}) and surface a
// real conflict (e.g. diverging YAML frontmatter) as conflictRegions>0 with full-file
// markers, instead of silently dropping it. See docs/spec.md §6.2 / §18 (F4 resolved).
import { Diff3Strategy } from '../../../src/sync/merge/Diff3Strategy';

describe('[SPEC:CF-12] Diff3Strategy detects real conflicts via node-diff3 diff3Merge', () => {
  const strategy = new Diff3Strategy();

  it('non-overlapping edits → clean merge (no conflict regions)', () => {
    const base = 'line one\nline two\nline three\n';
    const local = 'LOCAL one\nline two\nline three\n';
    const remote = 'line one\nline two\nREMOTE three\n';
    const r = strategy.merge(base, local, remote);
    expect(r.success).toBe(true);
    expect(r.hadConflicts).toBe(false);
    expect(r.conflictRegions).toBe(0);
    expect(r.mergedContent).not.toContain('<<<<<<<');
  });

  it('diverging frontmatter (same line changed on both sides) → conflict markers, not a silent merge', () => {
    // The F4 regression: this exact case was reported as conflictRegions:0 (silently merged).
    const base = '---\ntitle: base\n---\n\nbody\n';
    const local = '---\ntitle: local\n---\n\nbody\n';
    const remote = '---\ntitle: remote\n---\n\nbody\n';
    const r = strategy.merge(base, local, remote);
    expect(r.success).toBe(true);
    expect(r.hadConflicts).toBe(true);
    expect(r.conflictRegions).toBeGreaterThan(0);
    expect(r.mergedContent).toContain('<<<<<<< LOCAL');
    expect(r.mergedContent).toContain('=======');
    expect(r.mergedContent).toContain('>>>>>>> REMOTE');
  });

  it('counts multiple independent conflict regions', () => {
    const base = 'a\nx\nb\ny\nc\n';
    const local = 'a\nX1\nb\nY1\nc\n';
    const remote = 'a\nX2\nb\nY2\nc\n';
    const r = strategy.merge(base, local, remote);
    expect(r.hadConflicts).toBe(true);
    expect(r.conflictRegions).toBe(2);
  });
});
