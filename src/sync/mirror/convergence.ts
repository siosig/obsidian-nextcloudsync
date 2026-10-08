// A mirror moves only differing files, so afterwards the state DB must gain the skipped-but-identical
// files (else they read as conflicts) and lose files the remote no longer has (else they are re-created).
// Pure set arithmetic; the caller does the writing.
import { RemoteFileInfo } from '../../types';

export interface StateConvergence {
  // Present remotely but not downloaded, so never recorded by the transfer.
  toTrack: RemoteFileInfo[];
  // Tracked but gone from the remote; dropped together with their merge base.
  toDrop: string[];
}

// Excluded paths are left alone on both sides: the config folder is tracked by its own mechanism, and
// dropping its entries here would make the next sync re-download it.
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
