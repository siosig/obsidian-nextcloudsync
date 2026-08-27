// Direct tests for the local-unchanged fast-path (feature 074, Phase 1).
//
// Deliberately carries no [SPEC:...] tags. The clauses these rules serve are already claimed by the
// SyncEngine-level tests; tagging here too would double-count one behaviour in the coverage checker.
// What this file adds is reach, not coverage: before the predicate was a plain function, the safety
// window could only be approached through a whole engine, and no test named it at all.
import { isLocallyUnchanged, withinSafetyWindow } from '../../../../src/sync/policy';
import { SIGNATURE_SAFETY_WINDOW_MS } from '../../../../src/util/limits';
import { FileState } from '../../../../src/types';

const W = SIGNATURE_SAFETY_WINDOW_MS;

/** A converged state whose stat signature matches `stat` below exactly. */
function baseAt(mtime: number, size = 100): FileState {
  return {
    path: 'note.md', localHash: 'h', remoteId: 'e', idType: 'etag',
    size, mtime, remoteFileId: null, isConflicted: false,
    localMtime: mtime, localSize: size,
  };
}

/** A clock far enough from every mtime used here that the window never trips by accident. */
const farClock = { now: () => 10_000_000, lastSyncTime: () => 0 };

describe('isLocallyUnchanged — signature preconditions', () => {
  it('demands a hash when the signature is absent (migrated or pre-signature state)', () => {
    const base = baseAt(1000);
    delete base.localMtime;
    expect(isLocallyUnchanged(base, { mtime: 1000, size: 100 }, farClock)).toBe(false);

    const base2 = baseAt(1000);
    delete base2.localSize;
    expect(isLocallyUnchanged(base2, { mtime: 1000, size: 100 }, farClock)).toBe(false);
  });

  it('demands a hash when the size or the mtime moved', () => {
    expect(isLocallyUnchanged(baseAt(1000), { mtime: 1000, size: 101 }, farClock)).toBe(false);
    expect(isLocallyUnchanged(baseAt(1000), { mtime: 1001, size: 100 }, farClock)).toBe(false);
  });

  it('trusts the file as unchanged when the whole signature matches', () => {
    expect(isLocallyUnchanged(baseAt(1000), { mtime: 1000, size: 100 }, farClock)).toBe(true);
  });
});

describe('isLocallyUnchanged — safety window boundaries', () => {
  // The window is why a same-size in-place edit made inside the filesystem's mtime granularity is
  // not silently skipped. Its edges are what decide whether a real edit is seen, so they are pinned
  // here rather than left to the constant.
  const mtime = 1_000_000;
  const stat = { mtime, size: 100 };

  it.each([
    ['just inside (now is 1 ms nearer than the window)', W - 1, false],
    ['exactly at the window edge', W, true],
    ['well outside', W * 10, true],
  ])('now %s → unchanged=%s', (_label, delta, expected) => {
    const clock = { now: () => mtime + (delta as number), lastSyncTime: () => 0 };
    expect(isLocallyUnchanged(baseAt(mtime), stat, clock)).toBe(expected);
  });

  it('applies the window symmetrically — an mtime in the future is just as suspect', () => {
    const clock = { now: () => mtime - (W - 1), lastSyncTime: () => 0 };
    expect(isLocallyUnchanged(baseAt(mtime), stat, clock)).toBe(false);
  });

  it('applies the same window around the previous sync completion', () => {
    const near = { now: () => mtime + W * 10, lastSyncTime: () => mtime + W - 1 };
    expect(isLocallyUnchanged(baseAt(mtime), stat, near)).toBe(false);

    const edge = { now: () => mtime + W * 10, lastSyncTime: () => mtime + W };
    expect(isLocallyUnchanged(baseAt(mtime), stat, edge)).toBe(true);
  });

  it('ignores the last-sync window when there has never been a sync (lastSync = 0)', () => {
    // Without the `lastSync > 0` guard, a vault whose mtimes sit near the epoch would be forced to
    // rehash on the very first sync — the run that can least afford it.
    const nearEpoch = 1500;
    const base = baseAt(nearEpoch);
    const clock = { now: () => 10_000_000, lastSyncTime: () => 0 };
    expect(isLocallyUnchanged(base, { mtime: nearEpoch, size: 100 }, clock)).toBe(true);
  });
});

describe('isLocallyUnchanged — the time inputs stay lazy', () => {
  // This predicate runs once per file. Reading the clock and the state DB before the cheap checks
  // would turn a pure relocation into a per-file cost, so the accessors are asserted, not assumed.
  function spyClock(now: number, lastSync: number) {
    return {
      now: jest.fn(() => now),
      lastSyncTime: jest.fn(() => lastSync),
    };
  }

  it('consults neither accessor when the signature is missing', () => {
    const clock = spyClock(10_000_000, 0);
    const base = baseAt(1000);
    delete base.localMtime;
    isLocallyUnchanged(base, { mtime: 1000, size: 100 }, clock);
    expect(clock.now).not.toHaveBeenCalled();
    expect(clock.lastSyncTime).not.toHaveBeenCalled();
  });

  it('consults neither accessor when the size or mtime already disagrees', () => {
    const clock = spyClock(10_000_000, 0);
    isLocallyUnchanged(baseAt(1000), { mtime: 1000, size: 999 }, clock);
    expect(clock.now).not.toHaveBeenCalled();
    expect(clock.lastSyncTime).not.toHaveBeenCalled();
  });

  it('consults both exactly once when the checks get that far', () => {
    const clock = spyClock(10_000_000, 0);
    isLocallyUnchanged(baseAt(1000), { mtime: 1000, size: 100 }, clock);
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(clock.lastSyncTime).toHaveBeenCalledTimes(1);
  });
});

describe('withinSafetyWindow', () => {
  it('is a strict "less than" on the absolute distance, in both directions', () => {
    expect(withinSafetyWindow(1000, 1000)).toBe(true);
    expect(withinSafetyWindow(1000, 1000 + W - 1)).toBe(true);
    expect(withinSafetyWindow(1000, 1000 - (W - 1))).toBe(true);
    expect(withinSafetyWindow(1000, 1000 + W)).toBe(false);
    expect(withinSafetyWindow(1000, 1000 - W)).toBe(false);
  });
});
