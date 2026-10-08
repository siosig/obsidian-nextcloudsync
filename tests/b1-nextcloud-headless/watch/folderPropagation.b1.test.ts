// Layer B (WF-B1): with watch mode on, folder create/delete/rename propagate to a live Nextcloud immediately (MKCOL /
// collection delete via trashbin / MOVE), and a failed immediate op self-heals on the next full sync. it.skip stubs,
// surfaced as pending-adjudication waivers in the coverage catalog.

describe('Layer B (WF-B1) — watch-mode folder propagation against a live server', () => {
  // eslint-disable-next-line jest/no-disabled-tests
  it.skip('[SPEC:WF-B1-1] folder create/delete/rename propagate immediately (MKCOL / collection-delete / MOVE)', () => {
    // 1. createSingleFolder → the collection exists on the remote. 2. deleteSingleFolder (tracked) →
    //    the collection is gone from the live tree but recoverable from the trashbin. 3. renameSingleFolder
    //    → the collection is MOVEd (subtree preserved, not delete+recreate).
  });

  // eslint-disable-next-line jest/no-disabled-tests
  it.skip('[SPEC:WF-B1-2] after an immediate folder-op failure, the next full sync converges remote==local', () => {
    // Force an immediate op to fail (disconnect), then run a normal full sync and assert
    // reconcileDirectories re-applies the create/delete/rename so remote matches local.
  });
});
