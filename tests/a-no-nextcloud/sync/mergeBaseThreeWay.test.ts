// [SPEC:MB-1..MB-4] specs/038-merge-base-store — true 3-way merge with a real base (feature 038).
// Root cause of the "duplicated block" bug: the merge base was always '' (StateDB holds only hashes).
// With the last-synced body as base, reconcile no longer duplicates the blocks both sides share.
import { MergeEngine } from '../../../src/sync/merge/MergeEngine';

const occurrences = (s: string, needle: string): number => s.split(needle).length - 1;

describe('[SPEC:MB-1] base present → shared blocks are not duplicated', () => {
  // Common ancestor (what both sides started from): line1 / line3 / line4.
  // local added "line2 LOCAL" after line1; remote appended "REMOTE".
  const base = 'line1\nline3\nline4';
  const local = 'line1\nline2 LOCAL\nline3\nline4';
  const remote = 'line1\nline3\nline4\nREMOTE';

  it('merges cleanly with both edits and no duplicated shared block', () => {
    const engine = new MergeEngine({ maxConflictRegions: 0 });
    const r = engine.merge(base, local, remote);
    expect(r.success).toBe(true);
    expect(r.hadConflicts).toBe(false);
    // The shared lines appear exactly once (the empty-base bug emitted them twice).
    expect(occurrences(r.mergedContent, 'line3')).toBe(1);
    expect(occurrences(r.mergedContent, 'line4')).toBe(1);
    // Both sides' unique edits are preserved.
    expect(r.mergedContent).toContain('line2 LOCAL');
    expect(r.mergedContent).toContain('REMOTE');
  });
});

describe('[SPEC:MB-3] base absent → empty-base duplication is caught by the expansion guard', () => {
  it('the same inputs with base="" do NOT produce a clean merge (037 guard)', () => {
    const engine = new MergeEngine({ maxConflictRegions: 0 });
    const r = engine.merge('', 'line1\nline2 LOCAL\nline3\nline4', 'line1\nline3\nline4\nREMOTE');
    expect(r.success).toBe(false); // downgraded to conflict — corrupt body never written
  });
});

describe('[SPEC:MB-2][SPEC:MB-4] base advances → repeated conflicts stay clean (self-healing)', () => {
  it('after a clean merge, using it as the next base keeps subsequent merges duplication-free', () => {
    const engine = new MergeEngine({ maxConflictRegions: 0 });
    // Round 1: base seeded, clean merge.
    const base1 = 'line1\nline3\nline4';
    const merged1 = engine.merge(base1, 'line1\nline2 LOCAL\nline3\nline4', 'line1\nline3\nline4\nREMOTE');
    expect(merged1.success).toBe(true);
    // Round 2: the merged body becomes the new base; each side makes a fresh distinct edit.
    const base2 = merged1.mergedContent;
    const local2 = base2.replace('line2 LOCAL', 'line2 LOCAL v2');
    const remote2 = base2 + '\nREMOTE2';
    const merged2 = engine.merge(base2, local2, remote2);
    expect(merged2.success).toBe(true);
    expect(merged2.hadConflicts).toBe(false);
    expect(occurrences(merged2.mergedContent, 'line3')).toBe(1);
    expect(occurrences(merged2.mergedContent, 'line4')).toBe(1);
  });
});
