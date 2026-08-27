// The directory classification and the mass-delete breaker, as tables (feature 075).
//
// No [SPEC:...] tags: DP-* and DEL-* stay with the reconciler and engine suites.
//
// The point of extracting this was to be able to write the six cases down. Inside the loop they
// could only be traced; here the whole rule fits on a screen, and the two that are easy to invert
// sit next to each other:
//
//   local, no remote, NOT tracked  → created here      → push to remote
//   local, no remote, tracked      → deleted elsewhere → remove here
//
// Reading those the wrong way round either resurrects a folder the user deleted on another device
// or deletes one they just made.
import {
  classifyDirectories, shouldTripMassDeleteBreaker, breakerDenominator,
} from '../../../../src/sync/directory/classify';
import { RemoteDirInfo, DirState } from '../../../../src/types';

const remote = (path: string, fileId: string | null = null): RemoteDirInfo => ({
  path, fileId, etag: null, lastModified: 0,
});

function classify(
  opts: { remote?: string[]; local?: string[]; tracked?: string[]; excluded?: (p: string) => boolean },
) {
  return classifyDirectories(
    new Map((opts.remote ?? []).map((p) => [p, remote(p, `fid-${p}`)])),
    new Set(opts.local ?? []),
    new Map((opts.tracked ?? []).map((p) => [p, { path: p, remoteFileId: null } as DirState])),
    opts.excluded ?? (() => false),
  );
}

/** Which of the six lists a path landed in, for a single-path world. */
function outcomeOf(where: { local: boolean; remote: boolean; tracked: boolean }): string {
  const plan = classify({
    local: where.local ? ['D'] : [],
    remote: where.remote ? ['D'] : [],
    tracked: where.tracked ? ['D'] : [],
  });
  const hit = (Object.keys(plan) as (keyof typeof plan)[])
    .filter((k) => (plan[k] as unknown[]).length > 0);
  return hit.length === 1 ? hit[0] : `(${hit.length} lists)`;
}

describe('classifyDirectories — all six combinations', () => {
  it.each([
    // local, remote, tracked  →  outcome
    [true, true, true, 'ensureTracked'],
    [true, true, false, 'ensureTracked'],
    [true, false, false, 'mkcolRemote'],   // created here
    [true, false, true, 'trashLocal'],     // deleted elsewhere — the inverse of the line above
    [false, true, false, 'mkdirLocal'],    // created elsewhere
    [false, true, true, 'deleteRemote'],   // deleted here — the inverse of the line above
    [false, false, true, 'dropTracked'],   // gone everywhere
  ])('local=%s remote=%s tracked=%s → %s', (local, rem, tracked, expected) => {
    expect(outcomeOf({ local, remote: rem, tracked })).toBe(expected);
  });

  it('places every path in exactly one list', () => {
    const plan = classify({ local: ['a', 'b'], remote: ['b', 'c'], tracked: ['c', 'd'] });
    const all = [
      ...plan.mkcolRemote, ...plan.mkdirLocal, ...plan.deleteRemote,
      ...plan.trashLocal, ...plan.ensureTracked.map((d) => d.path), ...plan.dropTracked,
    ];
    expect(all.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(new Set(all).size).toBe(all.length); // disjoint
  });

  it('carries the remote id through for a folder on both sides', () => {
    const plan = classify({ local: ['D'], remote: ['D'] });
    expect(plan.ensureTracked).toEqual([{ path: 'D', remoteFileId: 'fid-D' }]);
  });

  it('classifies a folder present on both sides but never tracked as "keep tracked"', () => {
    // Not "created here": it already exists remotely, so pushing it would be a no-op MKCOL and
    // recording it is the whole job.
    expect(classify({ local: ['D'], remote: ['D'] }).mkcolRemote).toEqual([]);
  });

  it('never classifies the vault root itself', () => {
    expect(classify({ local: [''], remote: [''], tracked: [''] })).toEqual({
      mkcolRemote: [], mkdirLocal: [], deleteRemote: [], trashLocal: [],
      ensureTracked: [], dropTracked: [],
    });
  });

  it('drops excluded paths before classifying, not after', () => {
    // An excluded path should not appear in a plan at all — not even as something to skip later.
    const plan = classify({
      local: ['.git', 'Keep'], remote: ['.trash'], tracked: ['.git'],
      excluded: (p) => p.startsWith('.'),
    });
    expect(plan.mkcolRemote).toEqual(['Keep']);
    expect(plan.trashLocal).toEqual([]);
    expect(plan.mkdirLocal).toEqual([]);
    expect(plan.dropTracked).toEqual([]);
  });

  it('returns six empty lists for three empty sets', () => {
    expect(classify({})).toEqual({
      mkcolRemote: [], mkdirLocal: [], deleteRemote: [], trashLocal: [],
      ensureTracked: [], dropTracked: [],
    });
  });
});

describe('shouldTripMassDeleteBreaker', () => {
  /** A plan whose destructive half holds `n` paths and nothing else. */
  function destructive(n: number, split: 'remote' | 'local' | 'both' = 'remote') {
    const paths = Array.from({ length: n }, (_, i) => `d${i}`);
    const half = Math.ceil(n / 2);
    return {
      mkcolRemote: [], mkdirLocal: [], ensureTracked: [], dropTracked: [],
      deleteRemote: split === 'local' ? [] : split === 'both' ? paths.slice(0, half) : paths,
      trashLocal: split === 'remote' ? [] : split === 'both' ? paths.slice(half) : paths,
    };
  }

  describe('the automatic limit — max(20, 20% of the set)', () => {
    it.each([
      [20, 20, false],   // at the floor
      [21, 21, true],    // one past it
      [20, 500, false],  // 20% of 500 = 100, so 20 is far under
      [100, 500, false], // exactly 20%
      [101, 500, true],  // one past 20%
    ])('%s deletions against %s folders → trips=%s', (deletions, denom, expected) => {
      expect(shouldTripMassDeleteBreaker(destructive(deletions), denom, -1)).toBe(expected);
    });
  });

  it('counts both destructive lists together, not separately', () => {
    // 11 remote + 10 local is 21 deletions, which trips even though neither half would alone.
    expect(shouldTripMassDeleteBreaker(destructive(21, 'both'), 21, -1)).toBe(true);
  });

  it('ignores the non-destructive lists entirely', () => {
    const plan = { ...destructive(5), mkcolRemote: Array.from({ length: 500 }, (_, i) => `n${i}`) };
    expect(shouldTripMassDeleteBreaker(plan, 500, -1)).toBe(false);
  });

  it.each([
    ['0 means the breaker is off', 0, 5000, false],
    ['a fixed limit is honoured exactly', 4, 5, true],
    ['a fixed limit is not exceeded at the boundary', 5, 5, false],
  ])('%s', (_label, configured, deletions, expected) => {
    expect(shouldTripMassDeleteBreaker(destructive(deletions), deletions, configured)).toBe(expected);
  });

  it('never trips on an empty plan, whatever the limit', () => {
    for (const limit of [-1, 0, 1]) {
      expect(shouldTripMassDeleteBreaker(destructive(0), 0, limit)).toBe(false);
    }
  });
});

describe('breakerDenominator', () => {
  it('takes the largest of the three sets', () => {
    // Scaling against the smallest would let a truncated listing shrink its own safety margin.
    const denom = breakerDenominator(
      new Map([['a', 1]]),                      // remote reports 1
      new Set(['a', 'b', 'c']),                 // local has 3
      new Map([['a', 1], ['b', 2]]),            // tracked has 2
    );
    expect(denom).toBe(3);
  });

  it('is 0 when nothing exists anywhere', () => {
    expect(breakerDenominator(new Map(), new Set(), new Map())).toBe(0);
  });
});
