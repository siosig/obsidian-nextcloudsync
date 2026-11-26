// docs/spec.md §5.3b: the stat signature stored next to a hash must come from a stat taken before the read that
// produced that hash. withPreReadSignature stamps such a signature; withoutLocalSignature drops it so the next
// sync re-reads and re-hashes the file. Both are pure and return new objects.
import { withPreReadSignature, withoutLocalSignature } from '../../../src/data/localSignature';
import { isLocallyUnchanged } from '../../../src/sync/policy';
import type { FileState } from '../../../src/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const SIG_MTIME = 1_700_000_000_000;

// Every optional field is populated so that "keeps all other fields" is checked against the full shape.
function makeState(): FileState {
  return {
    path: 'Notes/a.md',
    localHash: 'hash-a',
    remoteId: 'remote-a',
    idType: 'sha256',
    size: 7,
    mtime: 1_600_000_000_000,
    remoteFileId: 'fileid-1',
    isConflicted: true,
    localMtime: 1_650_000_000_000,
    localSize: 7,
    remoteMtime: 1_660_000_000_000,
    ctimeLocalAttempt: 1_500_000_000,
    ctimeRemoteAttempt: 1_510_000_000,
  };
}

describe('[SPEC:ETG-3] withPreReadSignature / withoutLocalSignature', () => {
  describe('withPreReadSignature', () => {
    it('stamps the signature mtime and size onto the state', () => {
      const out = withPreReadSignature(makeState(), { mtime: SIG_MTIME, size: 42 });
      expect(out.localMtime).toBe(SIG_MTIME);
      expect(out.localSize).toBe(42);
    });

    it('keeps every other field of the state', () => {
      const base = makeState();
      const out = withPreReadSignature(base, { mtime: SIG_MTIME, size: 42 });
      expect(out).toEqual({ ...base, localMtime: SIG_MTIME, localSize: 42 });
    });

    it('sets remoteMtime when it is given (5)', () => {
      const out = withPreReadSignature(makeState(), { mtime: SIG_MTIME, size: 42 }, 5);
      expect(out.remoteMtime).toBe(5);
    });

    it('sets remoteMtime when it is 0 (only null and undefined are skipped)', () => {
      const out = withPreReadSignature(makeState(), { mtime: SIG_MTIME, size: 42 }, 0);
      expect(out.remoteMtime).toBe(0);
    });

    it.each([
      ['null', null],
      ['omitted', undefined],
    ])('keeps the original remoteMtime when remoteMtime is %s', (_label, remoteMtime) => {
      const base = makeState();
      const out = withPreReadSignature(base, { mtime: SIG_MTIME, size: 42 }, remoteMtime);
      expect(out.remoteMtime).toBe(base.remoteMtime);
    });

    it('leaves remoteMtime absent when neither the state nor the argument has one', () => {
      const base = makeState();
      delete base.remoteMtime;
      const out = withPreReadSignature(base, { mtime: SIG_MTIME, size: 42 }, null);
      expect(out.remoteMtime).toBeUndefined();
    });

    it('overwrites a stale signature already on the state', () => {
      const base = makeState();
      const out = withPreReadSignature(base, { mtime: SIG_MTIME, size: 1 });
      expect(out.localMtime).toBe(SIG_MTIME);
      expect(out.localSize).toBe(1);
      expect(out.localMtime).not.toBe(base.localMtime);
    });

    it('does not mutate the input state and returns a new object', () => {
      const base = makeState();
      const copy = { ...base };
      const out = withPreReadSignature(base, { mtime: SIG_MTIME, size: 42 }, 5);
      expect(base).toEqual(copy);
      expect(out).not.toBe(base);
    });

    it('does not mutate the input state when the state has no signature yet', () => {
      const base = makeState();
      delete base.localMtime;
      delete base.localSize;
      const copy = { ...base };
      const out = withPreReadSignature(base, { mtime: SIG_MTIME, size: 42 });
      expect(base).toEqual(copy);
      expect(base.localMtime).toBeUndefined();
      expect(out.localMtime).toBe(SIG_MTIME);
    });
  });

  describe('withoutLocalSignature', () => {
    it('sets localMtime and localSize to undefined and keeps every other field', () => {
      const base = makeState();
      const out = withoutLocalSignature(base);
      expect(out.localMtime).toBeUndefined();
      expect(out.localSize).toBeUndefined();
      // toStrictEqual also pins the object shape: the two keys stay present (no delete).
      expect(out).toStrictEqual({ ...base, localMtime: undefined, localSize: undefined });
    });

    it('keeps the hash, remote id, remote file id, conflict flag and remoteMtime', () => {
      const base = makeState();
      const out = withoutLocalSignature(base);
      expect(out.localHash).toBe(base.localHash);
      expect(out.remoteId).toBe(base.remoteId);
      expect(out.idType).toBe(base.idType);
      expect(out.size).toBe(base.size);
      expect(out.mtime).toBe(base.mtime);
      expect(out.remoteFileId).toBe(base.remoteFileId);
      expect(out.isConflicted).toBe(base.isConflicted);
      expect(out.remoteMtime).toBe(base.remoteMtime);
      expect(out.ctimeLocalAttempt).toBe(base.ctimeLocalAttempt);
      expect(out.ctimeRemoteAttempt).toBe(base.ctimeRemoteAttempt);
    });

    it('does not mutate the input state and returns a new object', () => {
      const base = makeState();
      const copy = { ...base };
      const out = withoutLocalSignature(base);
      expect(base).toEqual(copy);
      expect(base.localMtime).toBe(copy.localMtime);
      expect(base.localSize).toBe(copy.localSize);
      expect(out).not.toBe(base);
    });

    it('is idempotent and accepts a state that has no signature', () => {
      const base = makeState();
      delete base.localMtime;
      delete base.localSize;
      const once = withoutLocalSignature(base);
      const twice = withoutLocalSignature(once);
      expect(twice).toStrictEqual(once);
      expect(once.localMtime).toBeUndefined();
      expect(once.localSize).toBeUndefined();
    });

    it('makes isLocallyUnchanged return false even when the file stat matches the dropped signature', () => {
      const base = makeState();
      const stat = { mtime: base.localMtime as number, size: base.localSize as number };
      // Far from both the clock and the last sync, so the safety window cannot be what returns false.
      const clock = { now: (): number => (base.localMtime as number) + 10 * DAY_MS, lastSyncTime: (): number => 0 };

      // Control: the full signature with a matching stat is "unchanged".
      expect(isLocallyUnchanged(base, stat, clock)).toBe(true);
      // Dropping the signature forces the next sync to read and hash the file.
      expect(isLocallyUnchanged(withoutLocalSignature(base), stat, clock)).toBe(false);
    });
  });
});
