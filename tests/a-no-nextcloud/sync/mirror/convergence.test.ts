// The state convergence a mirror has to leave behind.
//
// No [SPEC:...] tags: MIR-* stays with the mirror service suite.
//
// Both gaps this closes are silent until the NEXT sync reads them wrong, which is what makes them
// worth stating as a rule rather than tracing through the apply loop: a skipped file the transfer
// never recorded reads as a conflict, and a tracked file the remote no longer has gets re-created.
import { leftoverFileState, planDirConvergence, planStateConvergence } from '../../../../src/sync/mirror/convergence';
import { RemoteDirInfo, RemoteFileInfo } from '../../../../src/types';

const remote = (path: string): RemoteFileInfo => ({
  path, fileId: `fid-${path}`, checksum: null, etag: '"e"', size: 1, lastModified: 0,
});

function plan(o: {
  remote?: string[]; downloaded?: string[]; tracked?: string[]; excluded?: (p: string) => boolean;
}) {
  const r = planStateConvergence(
    (o.remote ?? []).map(remote),
    new Set(o.downloaded ?? []),
    o.tracked ?? [],
    o.excluded ?? (() => false),
  );
  return { toTrack: r.toTrack.map((f) => f.path), toDrop: r.toDrop };
}

describe('planStateConvergence', () => {
  it('tracks a remote file the mirror skipped', () => {
    // Skipped = content already identical, so downloadFile never ran and never recorded it.
    expect(plan({ remote: ['same.md'], downloaded: [] })).toEqual({ toTrack: ['same.md'], toDrop: [] });
  });

  it('does not re-track a file the download already recorded', () => {
    expect(plan({ remote: ['new.md'], downloaded: ['new.md'] })).toEqual({ toTrack: [], toDrop: [] });
  });

  it('drops a tracked file the remote no longer has', () => {
    expect(plan({ remote: [], tracked: ['stale.md'] })).toEqual({ toTrack: [], toDrop: ['stale.md'] });
  });

  it('keeps a tracked file the remote still has', () => {
    expect(plan({ remote: ['kept.md'], downloaded: ['kept.md'], tracked: ['kept.md'] }).toDrop).toEqual([]);
  });

  it('handles both gaps at once', () => {
    const r = plan({
      remote: ['skipped.md', 'fetched.md'],
      downloaded: ['fetched.md'],
      tracked: ['fetched.md', 'gone.md'],
    });
    expect(r).toEqual({ toTrack: ['skipped.md'], toDrop: ['gone.md'] });
  });

  it('leaves excluded paths alone on BOTH sides', () => {
    // The config folder has its own tracking. Recording it here would be wrong, and dropping it
    // would make the next sync re-download the whole folder.
    const r = plan({
      remote: ['.obsidian/other.json', 'a.md'],
      tracked: ['.obsidian/workspace.json'],
      excluded: (p) => p.startsWith('.obsidian/'),
    });
    expect(r).toEqual({ toTrack: ['a.md'], toDrop: [] });
  });

  it('drops nothing and tracks nothing when both sides are empty', () => {
    expect(plan({})).toEqual({ toTrack: [], toDrop: [] });
  });

  it('tracks every remote file when the mirror downloaded none of them', () => {
    expect(plan({ remote: ['a.md', 'b.md'] }).toTrack).toEqual(['a.md', 'b.md']);
  });

  it('does not confuse a downloaded path with a tracked one', () => {
    // A file can be downloaded without having been tracked before, and vice versa.
    const r = plan({ remote: ['a.md'], downloaded: ['a.md'], tracked: ['b.md'] });
    expect(r).toEqual({ toTrack: [], toDrop: ['b.md'] });
  });
});

const remoteDir = (path: string): RemoteDirInfo => ({
  path, fileId: `fid-${path}`, etag: '"e"', lastModified: 0,
});

function planDirs(o: {
  remote?: string[]; local?: string[]; tracked?: string[]; excluded?: (p: string) => boolean;
}) {
  return planDirConvergence(
    (o.remote ?? []).map(remoteDir),
    new Set(o.local ?? []),
    o.tracked ?? [],
    o.excluded ?? (() => false),
  );
}

describe('planDirConvergence', () => {
  it('tracks a remote folder that exists locally', () => {
    expect(planDirs({ remote: ['d'], local: ['d'] })).toEqual({
      toTrack: [{ path: 'd', remoteFileId: 'fid-d' }],
      toDrop: [],
    });
  });

  it('leaves alone an untracked remote folder that is missing locally', () => {
    expect(planDirs({ remote: ['d'], local: [] })).toEqual({ toTrack: [], toDrop: [] });
  });

  it('drops a tracked folder that is on the remote but missing locally', () => {
    expect(planDirs({ remote: ['d'], local: [], tracked: ['d'] })).toEqual({ toTrack: [], toDrop: ['d'] });
  });

  it('drops a tracked folder the remote no longer has', () => {
    expect(planDirs({ remote: [], local: ['d'], tracked: ['d'] })).toEqual({ toTrack: [], toDrop: ['d'] });
  });

  it('ignores excluded paths on both sides', () => {
    const r = planDirs({
      remote: ['.cfg', 'd'], local: ['.cfg', 'd'], tracked: ['.cfg', '.cfg2'],
      excluded: (p) => p.startsWith('.cfg'),
    });
    expect(r).toEqual({ toTrack: [{ path: 'd', remoteFileId: 'fid-d' }], toDrop: [] });
  });

  it('returns empty sets for empty input', () => {
    expect(planDirs({})).toEqual({ toTrack: [], toDrop: [] });
  });
});

describe('keepTracked', () => {
  const noExclude = () => false;

  it('planStateConvergence keeps a tracked path absent from the remote when it is in keepTracked', () => {
    const r = planStateConvergence([], new Set(), ['left.md', 'gone.md'], noExclude, new Set(['left.md']));
    expect(r.toDrop).toEqual(['gone.md']);
  });

  it('planStateConvergence drops that path when keepTracked is omitted', () => {
    expect(planStateConvergence([], new Set(), ['left.md'], noExclude).toDrop).toEqual(['left.md']);
  });

  it('planStateConvergence toTrack is unaffected by keepTracked', () => {
    const args = [[remote('a.md')], new Set<string>(), ['x.md'], noExclude] as const;
    const without = planStateConvergence(...args);
    const withKeep = planStateConvergence(...args, new Set(['a.md', 'x.md']));
    expect(withKeep.toTrack.map((f) => f.path)).toEqual(without.toTrack.map((f) => f.path));
    expect(withKeep.toTrack.map((f) => f.path)).toEqual(['a.md']);
  });

  it('planDirConvergence keeps a tracked folder dropped by the plan when it is in keepTracked', () => {
    const r = planDirConvergence([], new Set(['d', 'e']), ['d', 'e'], noExclude, new Set(['d']));
    expect(r.toDrop).toEqual(['e']);
  });

  it('planDirConvergence drops that folder when keepTracked is omitted', () => {
    expect(planDirConvergence([], new Set(['d']), ['d'], noExclude).toDrop).toEqual(['d']);
  });

  it('planDirConvergence toTrack is unaffected by keepTracked', () => {
    const args = [[remoteDir('d')], new Set(['d']), ['x'], noExclude] as const;
    const without = planDirConvergence(...args);
    const withKeep = planDirConvergence(...args, new Set(['d', 'x']));
    expect(withKeep.toTrack).toEqual(without.toTrack);
    expect(withKeep.toTrack).toEqual([{ path: 'd', remoteFileId: 'fid-d' }]);
  });
});

describe('leftoverFileState', () => {
  it('records the current content as in sync with the remote', () => {
    expect(leftoverFileState('a.md', 'h', { size: 7, mtime: 55 }, 'fid')).toEqual({
      path: 'a.md', localHash: 'h', remoteId: 'h', idType: 'sha256', size: 7, mtime: 55,
      remoteFileId: 'fid', isConflicted: false,
    });
  });
});
