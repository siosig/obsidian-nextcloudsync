// Direct tests for RemoteListingSource (feature 074, Phase 2).
//
// No [SPEC:...] tags: ES-1..ES-10 are claimed by rootEtagShortcircuit.test.ts, which drives the same
// logic through SyncEngine and therefore also proves the wiring. This file covers what is awkward to
// reach from there — the State rebuild's own shape, and the checksum pass's batching.
import { RemoteListingSource, RemoteListingDeps } from '../../../../src/sync/scan/RemoteListingSource';
import { FileState, DirState, RemoteFileInfo } from '../../../../src/types';

function fileState(over: Partial<FileState> & { path: string }): FileState {
  return {
    localHash: 'h', remoteId: 'r', idType: 'etag', size: 1, mtime: 100,
    remoteFileId: null, isConflicted: false, ...over,
  };
}

function build(over: Partial<RemoteListingDeps> = {}, files: FileState[] = [], dirs: DirState[] = []) {
  let rootEtag: string | null = null;
  let skip = 0;
  const deps: RemoteListingDeps = {
    stateDB: {
      getAllFiles: () => files,
      getAllDirs: () => dirs,
      getRemoteRootEtag: () => rootEtag,
      setRemoteRootEtag: (e: string | null) => { rootEtag = e; },
      getFullScanSkipCount: () => skip,
      setFullScanSkipCount: (n: number) => { skip = n; },
    } as unknown as RemoteListingDeps['stateDB'],
    isNextcloud: () => true,
    networkConcurrency: () => 2,
    ...over,
  };
  return { source: new RemoteListingSource(deps) };
}

describe('RemoteListingSource — rebuilding the listing from State', () => {
  it('reads a sha256 baseline back as a checksum and an etag baseline back as an etag', () => {
    // The rebuilt entry has to compare as "remote unchanged" against its own base, so the recorded
    // id must land in the field its idType names — not in both, and not in the wrong one.
    const { source } = build({}, [
      fileState({ path: 'a.md', idType: 'sha256', remoteId: 'abc' }),
      fileState({ path: 'b.md', idType: 'etag', remoteId: '"e1"' }),
    ]);
    const [a, b] = source.rebuildRemoteFilesFromState();
    expect(a).toMatchObject({ path: 'a.md', checksum: 'abc', etag: null });
    expect(b).toMatchObject({ path: 'b.md', checksum: null, etag: '"e1"' });
  });

  it('prefers the recorded remote mtime, falling back to the local one when absent', () => {
    const { source } = build({}, [
      fileState({ path: 'a.md', mtime: 100, remoteMtime: 555 }),
      fileState({ path: 'b.md', mtime: 100 }),
    ]);
    const [a, b] = source.rebuildRemoteFilesFromState();
    expect(a.lastModified).toBe(555);
    expect(b.lastModified).toBe(100);
  });

  it('rebuilds one entry per tracked file, which is what absence-based deletion relies on', () => {
    const { source } = build({}, [fileState({ path: 'a.md' }), fileState({ path: 'b/c.md' })]);
    expect(source.rebuildRemoteFilesFromState().map(f => f.path).sort()).toEqual(['a.md', 'b/c.md']);
  });

  it('rebuilds directories with only what reconcileDirectories reads', () => {
    const { source } = build({}, [], [{ path: 'b', remoteFileId: 'fid-1' }]);
    expect(source.rebuildRemoteDirsFromState()).toEqual([
      { path: 'b', fileId: 'fid-1', etag: null, lastModified: 0 },
    ]);
  });

  it('rebuilds an empty listing from empty State rather than failing', () => {
    const { source } = build();
    expect(source.rebuildRemoteFilesFromState()).toEqual([]);
    expect(source.rebuildRemoteDirsFromState()).toEqual([]);
  });
});

describe('RemoteListingSource.resolveRemoteChecksums', () => {
  const client = (recalc: jest.Mock) => ({ recalcChecksum: recalc } as never);

  const remote = (path: string, checksum: string | null = null): RemoteFileInfo => ({
    path, fileId: null, checksum, etag: null, size: 1, lastModified: 0,
  });

  it('asks only for files that exist on both sides and still lack a checksum', async () => {
    const recalc = jest.fn(async (_path: string) => 'sum');
    const { source } = build();
    const files = [remote('both.md'), remote('remote-only.md'), remote('has.md', 'already')];
    await source.resolveRemoteChecksums(client(recalc), files, new Map([
      ['both.md', { size: 1, mtime: 1 }], ['has.md', { size: 1, mtime: 1 }],
    ]));
    expect(recalc.mock.calls.map(c => c[0])).toEqual(['both.md']);
    expect(files[0].checksum).toBe('sum');
  });

  it('leaves the checksum null when the server declines, without failing the pass', async () => {
    const recalc = jest.fn(async () => { throw new Error('unsupported'); });
    const { source } = build();
    const files = [remote('a.md')];
    await expect(
      source.resolveRemoteChecksums(client(recalc), files, new Map([['a.md', { size: 1, mtime: 1 }]])),
    ).resolves.toBeUndefined();
    expect(files[0].checksum).toBeNull();
  });

  it('ignores an empty answer rather than storing it as a checksum', async () => {
    const recalc = jest.fn(async () => '');
    const { source } = build();
    const files = [remote('a.md')];
    await source.resolveRemoteChecksums(client(recalc), files, new Map([['a.md', { size: 1, mtime: 1 }]]));
    expect(files[0].checksum).toBeNull();
  });

  it('runs in batches of the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const recalc = jest.fn(async () => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
      return 'sum';
    });
    const { source } = build({ networkConcurrency: () => 2 });
    const paths = ['a', 'b', 'c', 'd', 'e'];
    await source.resolveRemoteChecksums(
      client(recalc), paths.map(p => remote(p)), new Map(paths.map(p => [p, { size: 1, mtime: 1 }])),
    );
    expect(recalc).toHaveBeenCalledTimes(5);
    // Exactly 2, not "at most 2": an at-most assertion would pass just as happily if the pass had
    // silently become serial, which is the regression worth catching here.
    expect(peak).toBe(2);
  });

  it('terminates on a zero concurrency instead of looping forever', async () => {
    // The loop advances by this value. Its own floor is the only thing standing between a
    // misconfigured 0 and a hang, so it is asserted here rather than trusted to the caller.
    const recalc = jest.fn(async () => 'sum');
    const { source } = build({ networkConcurrency: () => 0 });
    await source.resolveRemoteChecksums(
      client(recalc), [remote('a.md')], new Map([['a.md', { size: 1, mtime: 1 }]]),
    );
    expect(recalc).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when no file qualifies', async () => {
    const recalc = jest.fn(async () => 'sum');
    const { source } = build();
    await source.resolveRemoteChecksums(client(recalc), [remote('remote-only.md')], new Map());
    expect(recalc).not.toHaveBeenCalled();
  });
});
