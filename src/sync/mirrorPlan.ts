import { RemoteFileInfo } from '../types';

/**
 * Pull mirror (feature 045): pure classification of what a "mirror this device from the remote"
 * operation must download and delete, given an authoritative remote listing and the local state.
 *
 * Extracted as a pure function (like `massDeleteLimit`) so the mirror contract is unit-testable in
 * the a-layer without a live server. The SyncEngine wraps this with real I/O (getFiles/download/
 * trashFile) and StateDB reconciliation.
 *
 * Safety: this operation intentionally bypasses the mass-delete breaker's COUNT limit (the user
 * explicitly declared the remote authoritative). The remaining guard is listing completeness:
 * when the remote listing could not be fully obtained, `ok` is false and every list is empty, so
 * the caller performs zero deletions (spec 045 FR-009 / SC-005).
 */

/** One local file the mirror can see: its vault-relative path and current content hash. */
export interface LocalFileEntry {
  path: string;
  hash: string;
}

/** The mirror plan: what to download, what to delete, and how many were already in sync. */
export interface MirrorPlan {
  /** True iff the authoritative remote listing was obtained completely. False ⇒ do nothing. */
  ok: boolean;
  /** Reason when `ok` is false (surfaced to the user); null when ok. */
  reason: string | null;
  /** Remote files to download (missing locally or content differs). */
  downloads: RemoteFileInfo[];
  /** Local-only files to delete (present locally, absent from the remote listing). */
  deleteFiles: string[];
  /** Local-only folders to delete (empty folders included), sorted child→parent. */
  deleteDirs: string[];
  /** Count of remote files already identical locally (skipped, no transfer). */
  skipCount: number;
  /** The authoritative remote listing (kept for apply + StateDB reconciliation). */
  remoteFiles: RemoteFileInfo[];
}

/** The outcome of applying a mirror plan. */
export interface MirrorResult {
  downloaded: number;
  deleted: number;
  skipped: number;
  errors: Array<{ path: string; message: string }>;
}

/**
 * Number of path segments — deeper paths have more. Used to sort folder deletions child→parent
 * so a parent is never removed before its children.
 */
function depth(path: string): number {
  return path.split('/').length;
}

/**
 * Build a {@link MirrorPlan} from an authoritative remote listing and the local state.
 *
 * @param remoteFiles  the COMPLETE remote file listing (from a real PROPFIND, no short-circuit)
 * @param localFiles   every local file the mirror may touch (path + content hash)
 * @param localDirs    every local folder the mirror may touch (vault-relative paths)
 * @param isExcluded   predicate for system/user exclusions (isSystemExcluded ∪ excluded folders)
 * @param listingOk    whether the remote listing was obtained completely (false ⇒ abort gate)
 * @param reason       optional reason to attach when listingOk is false
 */
export function buildMirrorPlan(
  remoteFiles: RemoteFileInfo[],
  localFiles: LocalFileEntry[],
  localDirs: string[],
  isExcluded: (path: string) => boolean,
  listingOk: boolean,
  reason: string | null = null,
): MirrorPlan {
  // Abort gate: an incomplete/failed listing must never drive deletions.
  if (!listingOk) {
    return {
      ok: false,
      reason: reason ?? 'Remote listing could not be obtained; mirror aborted (no changes made).',
      downloads: [],
      deleteFiles: [],
      deleteDirs: [],
      skipCount: 0,
      remoteFiles: [],
    };
  }

  const remoteEligible = remoteFiles.filter((r) => !isExcluded(r.path));
  const remoteSet = new Set(remoteEligible.map((r) => r.path));
  const localHashByPath = new Map(localFiles.map((f) => [f.path, f.hash]));

  const downloads: RemoteFileInfo[] = [];
  let skipCount = 0;
  for (const r of remoteEligible) {
    const localHash = localHashByPath.get(r.path);
    // Skip only when we can PROVE the content already matches: a server-computed checksum that
    // equals the local hash. Missing locally, unknown checksum, or mismatch ⇒ download (safe side:
    // the vault ends up matching the remote regardless).
    if (localHash != null && r.checksum != null && r.checksum === localHash) {
      skipCount++;
    } else {
      downloads.push(r);
    }
  }

  // Local-only files (present locally, not on the remote) → delete. Excluded paths are untouched.
  const deleteFiles = localFiles
    .map((f) => f.path)
    .filter((p) => !isExcluded(p) && !remoteSet.has(p));

  // Local-only folders → delete. A folder is kept iff some remote file lives under it.
  const remoteDirPrefixes = remoteEligible.map((r) => r.path);
  const deleteDirs = localDirs
    .filter((d) => !isExcluded(d) && !remoteDirPrefixes.some((rp) => rp === d || rp.startsWith(d + '/')))
    // child→parent so a parent folder is never removed before its children
    .sort((a, b) => depth(b) - depth(a));

  return {
    ok: true,
    reason: null,
    downloads,
    deleteFiles,
    deleteDirs,
    skipCount,
    remoteFiles,
  };
}
