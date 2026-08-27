// The state convergence a mirror has to leave behind (feature 075).
//
// No [SPEC:...] tags: MIR-* stays with the mirror service suite.
//
// Both gaps this closes are silent until the NEXT sync reads them wrong, which is what makes them
// worth stating as a rule rather than tracing through the apply loop: a skipped file the transfer
// never recorded reads as a conflict, and a tracked file the remote no longer has gets re-created.
import { planStateConvergence } from '../../../../src/sync/mirror/convergence';
import { RemoteFileInfo } from '../../../../src/types';

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
