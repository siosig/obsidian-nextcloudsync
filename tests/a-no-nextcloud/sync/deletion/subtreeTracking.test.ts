// Feature 086 (issue #46): when the plugin itself moves a folder to `.trash`, the tracking for
// everything under it has to go too.
//
// Why this is the whole bug in miniature: the old code dropped the FOLDER's row and left the child
// FILE rows behind. A leftover row says "this file was synced and is now gone locally", which the
// next sync reads as "the user deleted it" and propagates to the server. So a listing glitch that
// only ever removed files locally got amplified into real, server-side deletions — exactly what the
// reporter saw in their Nextcloud trashbin.
//
// The two properties that matter here are (a) ALL THREE stores are dropped for every path, never a
// subset, and (b) the prefix match requires a real separator, so a sibling named `F2` is untouched.
import {
  collectSubtreePaths, dropSubtreeTracking, SubtreeTrackingDeps,
} from '../../../../src/sync/deletion/subtreeTracking';

function build(trackedFiles: string[], trackedDirs: string[]) {
  let files = [...trackedFiles];
  let dirs = [...trackedDirs];
  const calls = {
    deleteFile: [] as string[],
    deleteDir: [] as string[],
    dropBase: [] as string[],
    dropSnapshot: [] as string[],
  };
  const deps: SubtreeTrackingDeps = {
    stateDB: {
      getAllFiles: () => files.map((path) => ({ path })),
      getAllDirs: () => dirs.map((path) => ({ path })),
      deleteFile: (p: string) => { calls.deleteFile.push(p); files = files.filter((f) => f !== p); },
      deleteDir: (p: string) => { calls.deleteDir.push(p); dirs = dirs.filter((d) => d !== p); },
    } as unknown as SubtreeTrackingDeps['stateDB'],
    mergeBase: { drop: (p: string) => { calls.dropBase.push(p); } },
    dropCleanSnapshot: (p: string) => { calls.dropSnapshot.push(p); },
  };
  return { deps, calls, remaining: () => ({ files, dirs }) };
}

describe('GDP-1 collectSubtreePaths — what counts as "under" a folder', () => {
  it('collects the folder itself and everything below it', () => {
    const { deps } = build(['F/a.md', 'F/sub/b.md'], ['F', 'F/sub']);
    const found = collectSubtreePaths(deps.stateDB, 'F');
    expect(found.files.sort()).toEqual(['F/a.md', 'F/sub/b.md']);
    expect(found.dirs.sort()).toEqual(['F', 'F/sub']);
  });

  // The separator is the whole guard. Without it, trashing `F` would also forget `F2` and `F.md`,
  // and those rows would then be re-uploaded as brand-new files on the next sync.
  it('GDP-2 requires a path separator, so siblings sharing a name prefix are never included', () => {
    const { deps } = build(
      ['F/a.md', 'F2/note.md', 'F.md', 'FF/note.md', 'G/F/note.md'],
      ['F', 'F2', 'FF', 'G/F'],
    );
    const found = collectSubtreePaths(deps.stateDB, 'F');
    expect(found.files).toEqual(['F/a.md']);
    expect(found.dirs).toEqual(['F']);
  });

  it('GDP-2 returns nothing for an empty folder path, so the vault root is never swept', () => {
    const { deps } = build(['a.md', 'F/b.md'], ['F']);
    expect(collectSubtreePaths(deps.stateDB, '')).toEqual({ files: [], dirs: [] });
  });
});

describe('GDP-3 dropSubtreeTracking — all three stores, or none', () => {
  it('drops file state, merge base and clean-side snapshot for every file under the folder', () => {
    const { deps, calls } = build(['F/a.md', 'F/sub/b.md', 'Other/c.md'], ['F', 'F/sub', 'Other']);

    dropSubtreeTracking(deps, 'F');

    // Every dropped file must appear in ALL THREE lists: a partial drop leaks a merge base or a
    // clean-side snapshot, which later mis-merges the file if it ever comes back.
    for (const p of ['F/a.md', 'F/sub/b.md']) {
      expect(calls.deleteFile).toContain(p);
      expect(calls.dropBase).toContain(p);
      expect(calls.dropSnapshot).toContain(p);
    }
    expect(calls.deleteDir.sort()).toEqual(['F', 'F/sub']);
  });

  it('leaves everything outside the folder alone', () => {
    const { deps, calls, remaining } = build(['F/a.md', 'Other/c.md', 'F.md'], ['F', 'Other']);
    dropSubtreeTracking(deps, 'F');
    expect(calls.deleteFile).toEqual(['F/a.md']);
    expect(remaining().files.sort()).toEqual(['F.md', 'Other/c.md']);
    expect(remaining().dirs).toEqual(['Other']);
  });

  it('reports how many rows it dropped, so the caller can say so in the log', () => {
    const { deps } = build(['F/a.md', 'F/sub/b.md'], ['F', 'F/sub']);
    expect(dropSubtreeTracking(deps, 'F')).toEqual({ files: 2, dirs: 2 });
  });

  it('is idempotent — a second call finds nothing left and touches no store', () => {
    const { deps, calls } = build(['F/a.md'], ['F']);
    dropSubtreeTracking(deps, 'F');
    const before = calls.deleteFile.length + calls.deleteDir.length;
    expect(dropSubtreeTracking(deps, 'F')).toEqual({ files: 0, dirs: 0 });
    expect(calls.deleteFile.length + calls.deleteDir.length).toBe(before);
  });

  it('does nothing at all for an empty folder path', () => {
    const { deps, calls } = build(['a.md'], ['F']);
    expect(dropSubtreeTracking(deps, '')).toEqual({ files: 0, dirs: 0 });
    expect(calls.deleteFile).toEqual([]);
    expect(calls.deleteDir).toEqual([]);
  });
});
