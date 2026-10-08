// Classifies directories by which of three sets (local, remote, tracked) they appear in. A folder present
// locally but absent remotely is "created here" if untracked and "deleted there" if tracked; mixing the two
// resurrects a deleted folder or deletes a new one.
import { RemoteDirInfo, DirState } from '../../types';
import { effectiveMassDeleteLimit } from '../../util/limits';

// Per-path outcome (L=local, R=remote, T=tracked); every list is disjoint from the others.
export interface DirectoryPlan {
  // L !R !T — created here → push to remote.
  mkcolRemote: string[];
  // !L R !T — created elsewhere → create here.
  mkdirLocal: string[];
  // !L R T — deleted here → remove on remote.
  deleteRemote: string[];
  // L !R T — deleted elsewhere → remove here.
  trashLocal: string[];
  // L R — present on both sides → keep tracked, refreshing the remote id.
  ensureTracked: DirState[];
  // !L !R T — gone everywhere → forget.
  dropTracked: string[];
}

// Excluded paths are dropped before classification so they never appear in a plan.
export function classifyDirectories(
  remoteDirs: ReadonlyMap<string, RemoteDirInfo>,
  localDirs: ReadonlySet<string>,
  tracked: ReadonlyMap<string, DirState>,
  isExcluded: (path: string) => boolean,
): DirectoryPlan {
  const plan: DirectoryPlan = {
    mkcolRemote: [], mkdirLocal: [], deleteRemote: [], trashLocal: [],
    ensureTracked: [], dropTracked: [],
  };

  const all = new Set<string>(
    [...remoteDirs.keys(), ...localDirs, ...tracked.keys()].filter(p => p !== '' && !isExcluded(p)),
  );

  for (const p of all) {
    const L = localDirs.has(p), R = remoteDirs.has(p), T = tracked.has(p);
    if (L && R) plan.ensureTracked.push({ path: p, remoteFileId: remoteDirs.get(p)!.fileId });
    else if (L && !R) (T ? plan.trashLocal : plan.mkcolRemote).push(p);
    else if (!L && R) (T ? plan.deleteRemote : plan.mkdirLocal).push(p);
    else if (T) plan.dropTracked.push(p);
  }

  return plan;
}

// A partial remote listing looks like "the user deleted most folders", and only one reading is recoverable.
// Beyond the limit the whole destructive half is refused, not trimmed: a listing wrong about many folders
// is not trustworthy about any. `denominator` is the largest of the three sets so the automatic limit
// scales with vault size.
export function shouldTripMassDeleteBreaker(
  plan: DirectoryPlan, denominator: number, configuredLimit: number,
): boolean {
  return plan.deleteRemote.length + plan.trashLocal.length
    > effectiveMassDeleteLimit(configuredLimit, denominator);
}

export function breakerDenominator(
  remoteDirs: ReadonlyMap<string, unknown>,
  localDirs: ReadonlySet<string>,
  tracked: ReadonlyMap<string, unknown>,
): number {
  return Math.max(tracked.size, remoteDirs.size, localDirs.size);
}
