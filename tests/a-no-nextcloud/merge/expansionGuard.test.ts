// Feature 037 FR-005b / SC-009: the expansion circuit breaker. With an empty base (the State DB
// stores only hashes — true-base is feature 038), reconcile-text can DUPLICATE shared blocks. This
// guard downgrades such a bloated "clean" merge to a conflict so the corrupted body is never written.
//
// The block-duplication case runs the REAL reconcile-text to reproduce the known bug exactly; the
// length-overflow case uses a mocked reconcile (isolated module) to force an over-long merge.
import { MergeEngine } from '../../../src/sync/merge/MergeEngine';

describe('[SPEC:CSF-5] expansion guard — block duplication (real reconcile, SC-009)', () => {
  it('[SPEC:CSF-5] the known empty-base duplication is downgraded to a conflict, not a clean merge', () => {
    const engine = new MergeEngine();
    // Reproduction from SC-009: reconcile emits `line3\nline4` twice (an immediately-repeated block).
    const local = 'line1\nline2 LOCAL\nline3\nline4';
    const remote = 'line1\nline3\nline4\nREMOTE';
    const r = engine.merge('', local, remote);
    // Feature 048: the engine always returns a resolved result (success); `hadConflicts` signals the
    // downgrade to a (marker) conflict so the corrupted union is never written as a clean merge.
    expect(r.success).toBe(true);
    expect(r.hadConflicts).toBe(true);
  });

  it('[SPEC:CSF-5] a genuinely clean merge (distinct line edits) is NOT tripped', () => {
    const engine = new MergeEngine();
    const r = engine.merge('', 'line1\nLOCAL\nline3', 'line1\nline3\nREMOTE');
    expect(r.success).toBe(true);
    expect(r.hadConflicts).toBe(false);
  });
});

describe('[SPEC:CSF-5] expansion guard — length overflow (mocked reconcile)', () => {
  it('[SPEC:CSF-5] a merged body longer than local+remote combined is treated as a conflict', () => {
    jest.isolateModules(() => {
      // Force reconcile to return a body far longer than the two inputs combined.
      jest.doMock('reconcile-text', () => ({
        reconcile: (_b: string, l: string, r: string) => ({ text: (l + r).repeat(5) }),
      }));
      jest.doMock('node-diff3', () => ({ diff3Merge: () => [{ ok: [] }] }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MergeEngine: ME } = require('../../../src/sync/merge/MergeEngine') as typeof import('../../../src/sync/merge/MergeEngine');
      const engine = new ME();
      const res = engine.merge('', 'alpha', 'bravo');
      expect(res.hadConflicts).toBe(true); // downgraded to a conflict (feature 048: success stays true)
    });
  });
});
