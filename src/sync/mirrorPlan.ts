import { RemoteDirInfo, RemoteFileInfo } from '../types';

// Pure planning for the pull mirror, kept free of I/O so it is unit-testable (docs/spec.md §14).
// Mirror bypasses the mass-delete count limit; the remaining guard is listing completeness: when the
// listing is incomplete `ok` is false and every list is empty, so nothing is deleted.

export interface LocalFileEntry {
  path: string;
  hash: string;
  // Local stat at plan time; apply refuses to mark a skipped file converged when it has changed since.
  size: number;
  mtime: number;
}

export interface SkippedFile {
  path: string;
  size: number;
  mtime: number;
}

export interface MirrorPlan {
  ok: boolean;
  reason: string | null;
  downloads: RemoteFileInfo[];
  deleteFiles: string[];
  deleteDirs: string[];
  skipCount: number;
  remoteFiles: RemoteFileInfo[];
  skipped: SkippedFile[];
  // Non-excluded remote folders, paths without a trailing slash.
  remoteDirs: RemoteDirInfo[];
  // Remote folders missing locally, shallowest first.
  createDirs: string[];
}

export interface MirrorResult {
  downloaded: number;
  deleted: number;
  skipped: number;
  createdDirs: number;
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
  remoteDirs: RemoteDirInfo[] = [],
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
      skipped: [],
      remoteDirs: [],
      createDirs: [],
    };
  }

  const remoteEligible = remoteFiles.filter((r) => !isExcluded(r.path));
  const remoteSet = new Set(remoteEligible.map((r) => r.path));
  const localByPath = new Map(localFiles.map((f) => [f.path, f]));

  const downloads: RemoteFileInfo[] = [];
  const skipped: SkippedFile[] = [];
  for (const r of remoteEligible) {
    const local = localByPath.get(r.path);
    // Skip only when a server checksum proves the content matches; anything else downloads (safe side).
    if (local != null && r.checksum != null && r.checksum === local.hash) {
      skipped.push({ path: r.path, size: local.size, mtime: local.mtime });
    } else {
      downloads.push(r);
    }
  }

  const deleteFiles = localFiles
    .map((f) => f.path)
    .filter((p) => !isExcluded(p) && !remoteSet.has(p));

  // A folder is kept iff some remote file lives under it.
  const remoteDirPrefixes = remoteEligible.map((r) => r.path);
  // Trailing slashes are stripped so folder paths compare equal to localDirs entries.
  const outRemoteDirs = remoteDirs
    .map((d) => ({ ...d, path: d.path.replace(/\/+$/, '') }))
    .filter((d) => d.path !== '' && !isExcluded(d.path));
  const remoteDirSet = new Set(outRemoteDirs.map((d) => d.path));
  const localDirSet = new Set(localDirs);

  const createDirs = outRemoteDirs
    .map((d) => d.path)
    .filter((p) => !localDirSet.has(p))
    // Shallowest first so a parent exists before its children; ties in plain string order.
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));

  const deleteDirs = localDirs
    .filter(
      (d) =>
        !isExcluded(d) &&
        !remoteDirSet.has(d) &&
        !remoteDirPrefixes.some((rp) => rp === d || rp.startsWith(d + '/')),
    )
    // Deepest first, so a parent is never removed before its children.
    .sort((a, b) => depth(b) - depth(a));

  return {
    ok: true,
    reason: null,
    downloads,
    deleteFiles,
    deleteDirs,
    skipCount: skipped.length,
    remoteFiles,
    skipped,
    remoteDirs: outRemoteDirs,
    createDirs,
  };
}
