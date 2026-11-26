// Direct tests for the local-expectation helpers (docs/spec.md §5.3b): what a remote-to-local write assumed about
// the local file, the content check that runs after the remote body was fetched, and the deferral that keeps an
// edit saved during the transfer intact. The engine-level behaviour is covered by editDuringTransfer.test.ts.
import {
  EXPECT_ABSENT,
  EXPECT_OVERWRITE,
  LocalExpectation,
  deferChangedDuringTransfer,
  expectLocal,
  expectPresent,
  localStillAsDecided,
} from '../../../../src/sync/transfer/localExpectation';
import { FileState } from '../../../../src/types';
import { sha256 } from '../../../../src/util/hash';

const enc = new TextEncoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;

const C0 = 'a\n';
const C1 = 'a\nb\n';
const C2 = 'a\nb\nc\n';

describe('[SPEC:ETG-6] localStillAsDecided', () => {
  let h1: string;
  beforeAll(async () => { h1 = await sha256(toBuf(C1)); });

  // The six rows of the decision table: expectation x what is on disk after the fetch.
  const rows: Array<{
    name: string;
    expected: (hash: string) => LocalExpectation;
    present: boolean;
    bytes: string | null;
    result: boolean;
  }> = [
    { name: 'overwrite, whatever is on disk: not checked', expected: () => EXPECT_OVERWRITE, present: true, bytes: C2, result: true },
    { name: 'absent, still no file', expected: () => EXPECT_ABSENT, present: false, bytes: null, result: true },
    { name: 'absent, a file appeared', expected: () => EXPECT_ABSENT, present: true, bytes: C1, result: false },
    { name: 'present, the file is gone', expected: (h) => expectPresent(h), present: false, bytes: null, result: false },
    { name: 'present, same content (mtime-only change or changed and reverted)', expected: (h) => expectPresent(h), present: true, bytes: C1, result: true },
    { name: 'present, different content', expected: (h) => expectPresent(h), present: true, bytes: C2, result: false },
  ];

  it.each(rows)('$name -> $result', async ({ expected, present, bytes, result }) => {
    const got = await localStillAsDecided(expected(h1), present, bytes === null ? null : toBuf(bytes));
    expect(got).toBe(result);
  });

  const edges: Array<{
    name: string;
    expected: (hash: string) => LocalExpectation;
    present: boolean;
    bytes: string | null;
    result: boolean;
  }> = [
    { name: 'overwrite with no local file is still true', expected: () => EXPECT_OVERWRITE, present: false, bytes: null, result: true },
    { name: 'absent ignores the bytes when the file is gone', expected: () => EXPECT_ABSENT, present: false, bytes: C1, result: true },
    { name: 'present with unreadable bytes (null) while the file exists is not as decided', expected: (h) => expectPresent(h), present: true, bytes: null, result: false },
    { name: 'present against the empty-string hash (no local hash recorded) differs from real content', expected: () => expectPresent(''), present: true, bytes: C0, result: false },
  ];

  it.each(edges)('$name', async ({ expected, present, bytes, result }) => {
    const got = await localStillAsDecided(expected(h1), present, bytes === null ? null : toBuf(bytes));
    expect(got).toBe(result);
  });
});

describe('[SPEC:ETG-6] expectation constructors', () => {
  it('EXPECT_ABSENT and EXPECT_OVERWRITE are frozen constants of the right kind', () => {
    expect(EXPECT_ABSENT).toEqual({ kind: 'absent' });
    expect(EXPECT_OVERWRITE).toEqual({ kind: 'overwrite' });
    expect(Object.isFrozen(EXPECT_ABSENT)).toBe(true);
    expect(Object.isFrozen(EXPECT_OVERWRITE)).toBe(true);
  });

  it('expectPresent carries the hash', () => {
    expect(expectPresent('abc')).toEqual({ kind: 'present', hash: 'abc' });
  });

  it('expectLocal maps presence to present(hash) or the shared absent constant', () => {
    expect(expectLocal(true, 'abc')).toEqual({ kind: 'present', hash: 'abc' });
    expect(expectLocal(false, 'abc')).toBe(EXPECT_ABSENT);
  });
});

describe('[SPEC:ETG-5] deferChangedDuringTransfer', () => {
  const PATH = 'notes/a.md';

  const baseline = (): FileState => ({
    path: PATH,
    localHash: 'h-local',
    remoteId: 'h-remote',
    idType: 'sha256',
    size: 4,
    mtime: 1000,
    remoteFileId: 'fid-1',
    isConflicted: false,
    localMtime: 2000,
    localSize: 4,
    remoteMtime: 3000,
    ctimeLocalAttempt: 7,
    ctimeRemoteAttempt: 8,
  });

  function build(base: FileState | undefined, withLogger = true) {
    const setFile = jest.fn<void, [FileState]>();
    const getFile = jest.fn((p: string) => (p === PATH ? base : undefined));
    const queueRetry = jest.fn<void, [string]>();
    const log = jest.fn<Promise<void>, [string]>(async () => undefined);
    const deps = {
      stateDB: { getFile, setFile },
      queueRetry,
      ...(withLogger ? { logger: { log } } : {}),
    };
    return { deps, setFile, getFile, queueRetry, log };
  }

  it('(a) with a baseline, rewrites it once without the stat signature and keeps every other field', () => {
    const base = baseline();
    const { deps, setFile } = build(base);

    deferChangedDuringTransfer(deps, PATH, 'download');

    expect(setFile).toHaveBeenCalledTimes(1);
    const saved = setFile.mock.calls[0][0];
    expect(saved.localMtime).toBeUndefined();
    expect(saved.localSize).toBeUndefined();
    // toEqual ignores undefined-valued keys, so this compares every other field against the baseline.
    expect(saved).toEqual({ ...baseline(), localMtime: undefined, localSize: undefined });
    // Spot-check the fields the next sync relies on: the hash, the remote identity and the merge base stay.
    expect(saved.localHash).toBe('h-local');
    expect(saved.remoteId).toBe('h-remote');
    expect(saved.remoteFileId).toBe('fid-1');
    // The baseline object the state DB handed out is not mutated.
    expect(base).toEqual(baseline());
  });

  it('(b) queues exactly one retry for the path', () => {
    const { deps, queueRetry } = build(baseline());

    deferChangedDuringTransfer(deps, PATH, 'download');

    expect(queueRetry).toHaveBeenCalledTimes(1);
    expect(queueRetry).toHaveBeenCalledWith(PATH);
  });

  it.each(['download', 'conflict'] as const)('(c) logs one line in the contract wording (%s)', (what) => {
    const { deps, log } = build(baseline());

    deferChangedDuringTransfer(deps, PATH, what);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(`${what}: deferred — "${PATH}" changed locally during the transfer → re-evaluated next sync`);
  });

  it('(d) without a baseline, writes no state but still queues the retry and logs', () => {
    const { deps, setFile, queueRetry, log } = build(undefined);

    deferChangedDuringTransfer(deps, PATH, 'download');

    expect(setFile).not.toHaveBeenCalled();
    expect(queueRetry).toHaveBeenCalledTimes(1);
    expect(queueRetry).toHaveBeenCalledWith(PATH);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('works without a logger', () => {
    const { deps, setFile, queueRetry } = build(baseline(), false);

    expect(() => deferChangedDuringTransfer(deps, PATH, 'conflict')).not.toThrow();

    expect(setFile).toHaveBeenCalledTimes(1);
    expect(queueRetry).toHaveBeenCalledWith(PATH);
  });
});
