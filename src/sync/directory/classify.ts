// Directory difference classification (feature 075).
//
// Three sets — what the vault has, what the server has, what we last recorded — and six outcomes.
// The rule is entirely a matter of which of the three a path appears in, so it needs no I/O at all;
// it only ever lived inside reconcileDirectories because that is where it was written.
//
// Pulling it out is what lets the six cases be read as a table instead of traced through a loop.
// Two of them are easy to get backwards and expensive when you do: a folder present locally and
// absent remotely means "created here" when we never tracked it and "deleted there" when we did,
// and confusing those either resurrects a deleted folder or deletes a new one.
import { RemoteDirInfo, DirState } from '../../types';
import { effectiveMassDeleteLimit } from '../../util/limits';

/** What reconciliation should do, per path. Every list is disjoint from the others. */
export interface DirectoryPlan {
  /** L !R !T — created here → push to remote. */
  mkcolRemote: string[];
  /** !L R !T — created elsewhere → create here. */
  mkdirLocal: string[];
  /** !L R T — deleted here → remove on remote. */
  deleteRemote: string[];
  /** L !R T — deleted elsewhere → remove here. */
  trashLocal: string[];
  /** L R — present on both sides → keep tracked, refreshing the remote id. */
  ensureTracked: DirState[];
  /** !L !R T — gone everywhere → forget. */
  dropTracked: string[];
}

/**
 * Sort every path that appears in any of the three sets into exactly one outcome.
 *
 * Excluded paths are dropped before classification rather than after: a path the plugin must not
 * touch should not appear in a plan at all, not even as something to skip later.
 */
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

/**
 * True when the plan's destructive half is large enough to be a symptom rather than an intention.
 *
 * A partial remote listing is indistinguishable from "the user deleted most of their folders", and
 * only one of those two readings is recoverable. Beyond the limit the whole destructive half is
 * refused — not trimmed to the limit — because a listing that is wrong about many folders gives no
 * reason to trust it about any of them.
 *
 * `denominator` is the largest of the three sets, so the automatic limit scales with the size of the
 * vault rather than with whichever side happens to be reporting fewer folders.
 */
export function shouldTripMassDeleteBreaker(
  plan: DirectoryPlan, denominator: number, configuredLimit: number,
): boolean {
  return plan.deleteRemote.length + plan.trashLocal.length
    > effectiveMassDeleteLimit(configuredLimit, denominator);
}

/** The denominator {@link shouldTripMassDeleteBreaker} scales its automatic limit against. */
export function breakerDenominator(
  remoteDirs: ReadonlyMap<string, unknown>,
  localDirs: ReadonlySet<string>,
  tracked: ReadonlyMap<string, unknown>,
): number {
  return Math.max(tracked.size, remoteDirs.size, localDirs.size);
}
