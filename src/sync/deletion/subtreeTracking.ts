// Forgetting a folder subtree (feature 086, issue #46).
//
// When the plugin moves a folder to `.trash` — because the listing said the server no longer has it,
// or because the server reported the deletion — that is the PLUGIN deleting something, not the user.
// The distinction matters because the next sync cannot see it: a tracked file that is absent locally
// reads as "the user deleted this here", and gets propagated to the server as a DELETE.
//
// So a plugin-side trash that dropped only the folder's own row left every child row behind, and the
// next sync turned a local-only disappearance into a real remote deletion. That amplifier is what
// this module removes: the subtree stops being tracked at the same moment it stops being present.
//
// Dropping tracking is the safe direction in both worlds. If the trash was justified the files are
// gone on the server too and there is nothing to remember; if it was not, the next sync sees them as
// new remote files and downloads them back.
import { StateDB } from '../../data/StateDB';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';

export interface SubtreeTrackingDeps {
  stateDB: Pick<StateDB, 'getAllFiles' | 'getAllDirs' | 'deleteFile' | 'deleteDir'>;
  mergeBase: Pick<MergeBaseRecorder, 'drop'>;
  dropCleanSnapshot(path: string): void;
}

export interface SubtreePaths {
  files: string[];
  dirs: string[];
}

/**
 * Whether `path` is the folder itself or lives under it. The separator is required: without it
 * trashing `F` would also claim `F2/note.md` and `F.md`.
 */
function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** The tracked files and directories that a trash of `folder` makes stale. Pure; no side effects. */
export function collectSubtreePaths(
  stateDB: Pick<StateDB, 'getAllFiles' | 'getAllDirs'>, folder: string,
): SubtreePaths {
  if (!folder) return { files: [], dirs: [] }; // an empty path would match the whole vault
  return {
    files: stateDB.getAllFiles().map((f) => f.path).filter((p) => isUnder(p, folder)),
    dirs: stateDB.getAllDirs().map((d) => d.path).filter((p) => isUnder(p, folder)),
  };
}

/**
 * Stop tracking everything under `folder`, including `folder` itself. Returns how many rows went,
 * for the caller's log line.
 *
 * All three stores are dropped for every file. A partial drop is worse than none: a stranded merge
 * base or clean-side snapshot would later be used to reconcile a file that came back as a fresh
 * download, silently merging it against a version of itself the user never had.
 */
export function dropSubtreeTracking(
  deps: SubtreeTrackingDeps, folder: string,
): { files: number; dirs: number } {
  const { files, dirs } = collectSubtreePaths(deps.stateDB, folder);
  for (const path of files) {
    deps.stateDB.deleteFile(path);
    deps.mergeBase.drop(path);
    deps.dropCleanSnapshot(path);
  }
  for (const path of dirs) deps.stateDB.deleteDir(path);
  return { files: files.length, dirs: dirs.length };
}
