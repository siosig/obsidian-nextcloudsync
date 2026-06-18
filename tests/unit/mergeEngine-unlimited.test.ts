import { MergeEngine } from '../../src/sync/merge/MergeEngine';

// Force the diff3 fallback: reconcile-text returns no usable text, so ReconcileTextStrategy
// reports failure and MergeEngine falls back to node-diff3.
jest.mock('reconcile-text', () => ({
  reconcile: () => ({ text: undefined }),
}), { virtual: true });

// node-diff3 returns TWO conflict regions, so conflictRegions === 2.
jest.mock('node-diff3', () => ({
  merge: () => ({
    result: [
      { conflict: { a: ['local one'], b: ['remote one'] } },
      { ok: ['shared middle'] },
      { conflict: { a: ['local two'], b: ['remote two'] } },
    ],
    conflict: true,
  }),
}), { virtual: true });

const base = 'shared middle';
const local = 'local one\nshared middle\nlocal two';
const remote = 'remote one\nshared middle\nremote two';

describe('MergeEngine — maxConflictRegions = 0 means unlimited', () => {
  it('does NOT force fallback markers based on region count when the cap is 0', () => {
    const engine = new MergeEngine({ maxConflictRegions: 0 });
    const result = engine.merge(base, local, remote);
    // The region-count circuit breaker must be skipped: the diff3 merge result is kept.
    expect(result.success).toBe(true);
    expect(result.conflictRegions).toBe(2);
  });

  it('still caps when a positive threshold is exceeded', () => {
    const engine = new MergeEngine({ maxConflictRegions: 1 });
    const result = engine.merge(base, local, remote);
    // 2 regions > cap of 1 → fall back (success=false).
    expect(result.success).toBe(false);
  });
});
