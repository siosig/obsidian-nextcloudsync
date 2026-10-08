// A plugin-side trash of a folder must also drop its children's tracking, otherwise the next sync reads
// the absent tracked files as a user deletion and propagates a remote DELETE (issue #46, docs/spec.md §8a.1).
// Dropping tracking is the safe direction: if the trash was wrong, the files return as new remote files.
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

// The separator is required: without it trashing `F` would also claim `F2/note.md` and `F.md`.
function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

export function collectSubtreePaths(
  stateDB: Pick<StateDB, 'getAllFiles' | 'getAllDirs'>, folder: string,
): SubtreePaths {
  if (!folder) return { files: [], dirs: [] }; // an empty path would match the whole vault
  return {
    files: stateDB.getAllFiles().map((f) => f.path).filter((p) => isUnder(p, folder)),
    dirs: stateDB.getAllDirs().map((d) => d.path).filter((p) => isUnder(p, folder)),
  };
}

// All three stores are dropped for every file: a stranded merge base or clean snapshot would later be
// used to merge a freshly re-downloaded file against a version the user never had.
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
