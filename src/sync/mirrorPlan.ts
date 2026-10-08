import { RemoteFileInfo } from '../types';

// Pure planning for the pull mirror, kept free of I/O so it is unit-testable (docs/spec.md §14).
// Mirror bypasses the mass-delete count limit; the remaining guard is listing completeness: when the
// listing is incomplete `ok` is false and every list is empty, so nothing is deleted.

export interface LocalFileEntry {
  path: string;
  hash: string;
}

export interface MirrorPlan {
  ok: boolean;
  reason: string | null;
  downloads: RemoteFileInfo[];
  deleteFiles: string[];
  deleteDirs: string[];
  skipCount: number;
  remoteFiles: RemoteFileInfo[];
}

export interface MirrorResult {
  downloaded: number;
  deleted: number;
  skipped: number;
  errors: Array<{ path: string; message: string }>;
}

function depth(path: string): number {
  return path.split('/').length;
}

export function buildMirrorPlan(
  remoteFiles: RemoteFileInfo[],
  localFiles: LocalFileEntry[],
  localDirs: string[],
  isExcluded: (path: string) => boolean,
  listingOk: boolean,
  reason: string | null = null,
): MirrorPlan {
  // An incomplete listing must never drive deletions.
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
    // Skip only when a server checksum proves the content matches; anything else downloads (safe side).
    if (localHash != null && r.checksum != null && r.checksum === localHash) {
      skipCount++;
    } else {
      downloads.push(r);
    }
  }

  const deleteFiles = localFiles
    .map((f) => f.path)
    .filter((p) => !isExcluded(p) && !remoteSet.has(p));

  // A folder is kept iff some remote file lives under it.
  const remoteDirPrefixes = remoteEligible.map((r) => r.path);
  const deleteDirs = localDirs
    .filter((d) => !isExcluded(d) && !remoteDirPrefixes.some((rp) => rp === d || rp.startsWith(d + '/')))
    // Deepest first, so a parent is never removed before its children.
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
