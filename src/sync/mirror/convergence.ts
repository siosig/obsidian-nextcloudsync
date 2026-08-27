// State convergence after a mirror (feature 075).
//
// A mirror only moves the files that differ, so when it finishes the state DB does not yet describe
// what the vault now holds. Two gaps are left, and both are silent until the NEXT sync reads them
// wrong:
//
//   A file the mirror skipped — content already identical — was never recorded, so an untracked but
//   present file reads as a conflict and the reset appears to undo itself.
//
//   A file the state DB still tracks but the remote no longer has would be re-created locally.
//
// Deciding which files fall into each gap is set arithmetic over lists the caller already holds, so
// it needs no I/O. Only the writing does.
import { RemoteFileInfo } from '../../types';

export interface StateConvergence {
  /** Present remotely, not downloaded ⇒ never recorded by the transfer. Track them. */
  toTrack: RemoteFileInfo[];
  /** Tracked but no longer on the remote. Drop them, along with their merge base. */
  toDrop: string[];
}

/**
 * Work out which files the state DB must gain and which it must lose for the next ordinary sync to
 * see no difference at all.
 *
 * Excluded paths are left alone on BOTH sides. They are outside the plugin's scope, so a mirror has
 * no business either recording them or forgetting them — the config folder is tracked by its own
 * mechanism, and dropping its entries here would make the next sync re-download it.
 */
export function planStateConvergence(
  remoteFiles: readonly RemoteFileInfo[],
  downloadedPaths: ReadonlySet<string>,
  trackedPaths: readonly string[],
  isExcluded: (path: string) => boolean,
): StateConvergence {
  const eligibleRemote = remoteFiles.filter((r) => !isExcluded(r.path));
  const remoteSet = new Set(eligibleRemote.map((r) => r.path));
  return {
    toTrack: eligibleRemote.filter((r) => !downloadedPaths.has(r.path)),
    toDrop: trackedPaths.filter((p) => !isExcluded(p) && !remoteSet.has(p)),
  };
}
