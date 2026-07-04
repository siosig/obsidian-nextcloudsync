// Layer B (MIR-B1) — feature 045: Remote-authoritative Pull mirror against a live Nextcloud.
// These end-to-end cases prove the mirror behaves on a real server: mass local-only download+delete
// is NOT halted by the mass-delete breaker, folder deletion (incl. empty, child→parent) works, the
// listing-failure gate performs zero deletions, and the sync immediately after a mirror converges
// (self-healing). They are it.skip stubs for now (traced + documented; run under `pnpm test:b1` once
// wired to the live harness) — surfaced as pending-adjudication waivers in the coverage catalog, not
// silently passing. See specs/045-remote-mirror-pull/quickstart.md for the manual procedure.

describe('Layer B (MIR-B1) — Pull mirror against a live server', () => {
  // eslint-disable-next-line jest/no-disabled-tests
  it.skip('[SPEC:MIR-B1-1] mass local-only download+delete is not halted by the breaker; vault ends equal to the remote', () => {
    // 1. Seed the remote with N files; seed the local vault with those N plus M (>20% of tracked)
    //    local-only files. 2. Run planRemoteMirror + applyRemoteMirror. 3. Assert all M are trashed
    //    (breaker did not fire) and the local file set equals the remote set.
  });

  // eslint-disable-next-line jest/no-disabled-tests
  it.skip('[SPEC:MIR-B1-2] deletes local-only folders (incl. empty, child→parent); listing-failure gate deletes nothing', () => {
    // 1. Create local-only folders (empty and non-empty) absent on the remote → mirror deletes them
    //    deepest-first. 2. Force a listing failure (disconnect/auth) → planRemoteMirror returns ok:false
    //    and zero deletions occur.
  });

  // eslint-disable-next-line jest/no-disabled-tests
  it.skip('[SPEC:MIR-B1-3] the sync immediately after a mirror converges with zero upload/download/delete (self-healing)', () => {
    // After applyRemoteMirror, run a normal sync and assert uploaded=0, downloaded=0, deleted=0.
  });
});
