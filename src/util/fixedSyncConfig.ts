// Single source of truth for the five settings deprecated in feature 033. These were user-editable
// (restored in 032) but carry no needed per-user capability, so they are removed from the UI and
// pinned here to converge every user onto one path. Behavior reads these constants instead of
// `settings.<key>`; the persisted keys are dropped by pruneObsoleteSettings on next load.
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

/**
 * Upload chunk threshold in MB: files larger than this upload via the chunked API; smaller files use
 * a single PUT. Platform-derived (no user input): mobile uses a lower cutoff so large files chunk
 * earlier and reduce peak memory (a single PUT loads the whole file into memory, which is costly on
 * memory-constrained mobile, especially iOS requestUrl).
 */
export function chunkThresholdMB(isMobile: boolean): number {
  return isMobile ? 20 : 50;
}
