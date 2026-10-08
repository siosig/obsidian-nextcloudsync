// Fixed values for settings that are not user-editable, so every user takes one path (docs/spec.md
// §15.1.2). Behavior reads these instead of `settings.<key>`; persisted keys are dropped by
// pruneObsoleteSettings on load.
//
// - fileLockingEnabled: off — lost-update safety is the always-on If-Match precondition, without the
//   LOCK/UNLOCK round-trips.
// - chunkedUploadEnabled: on — still gated by the server-capability probe at the use-site.
// - maxConflictRegions: 0 — unlimited; an auto-merge is never downgraded to inline markers on region
//   count.
export const FIXED = {
  fileLockingEnabled: false,
  chunkedUploadEnabled: true,
  maxConflictRegions: 0,
} as const;

// Files larger than this upload via the chunked API. Mobile uses a lower cutoff because a single
// PUT loads the whole file into memory (costly on iOS requestUrl).
export function chunkThresholdMB(isMobile: boolean): number {
  return isMobile ? 20 : 50;
}
