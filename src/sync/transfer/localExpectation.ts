// What a remote-to-local write assumed about the local file when the sync classified it, and the check that
// the assumption still holds after the remote body was fetched (docs/spec.md §5.3b, docs/plan.md §7.4).
// Pure functions plus one small side-effecting deferral: no engine state is held here.
import type { StateDB } from '../../data/StateDB';
import type { FileLogger } from '../../util/FileLogger';
import { withoutLocalSignature } from '../../data/localSignature';
import { sha256 } from '../../util/hash';

export type LocalExpectation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly hash: string }
  | { readonly kind: 'overwrite' };

/** The local file did not exist when the sync classified the path. */
export const EXPECT_ABSENT: LocalExpectation = Object.freeze({ kind: 'absent' as const });

/** The user explicitly asked to replace the local file (mirror): the local content is not re-checked. */
export const EXPECT_OVERWRITE: LocalExpectation = Object.freeze({ kind: 'overwrite' as const });

/** The local file existed with content hash `hash` when the sync classified the path. */
export function expectPresent(hash: string): LocalExpectation {
  return Object.freeze({ kind: 'present' as const, hash });
}

/** present ? expectPresent(hash) : EXPECT_ABSENT */
export function expectLocal(localPresent: boolean, hash: string): LocalExpectation {
  return localPresent ? expectPresent(hash) : EXPECT_ABSENT;
}

/**
 * True when the local file is still what the classification assumed (docs/spec.md §5.3b).
 * overwrite → true; absent → !localPresent; present → localBytes !== null && sha256(localBytes) === hash.
 */
export async function localStillAsDecided(
  expected: LocalExpectation,
  localPresent: boolean,
  localBytes: ArrayBuffer | null,
): Promise<boolean> {
  switch (expected.kind) {
    case 'overwrite':
      return true;
    case 'absent':
      return !localPresent;
    case 'present':
      if (!localPresent || localBytes === null) return false;
      return (await sha256(localBytes)) === expected.hash;
  }
}

export interface DeferDeps {
  stateDB: Pick<StateDB, 'getFile' | 'setFile'>;
  queueRetry(path: string): void;
  logger?: Pick<FileLogger, 'log'>;
}

/**
 * The local file changed while the remote body was in flight: do not write it.
 * Keeps the baseline's hash, remote id and merge base, drops only the stat signature, and queues a retry.
 * Not an error: no recordError, no summary counter, no history entry, no notice (docs/spec.md §5.3b).
 */
export function deferChangedDuringTransfer(deps: DeferDeps, path: string, what: 'download' | 'conflict'): void {
  void deps.logger?.log(`${what}: deferred — "${path}" changed locally during the transfer → re-evaluated next sync`);
  const base = deps.stateDB.getFile(path);
  if (base) deps.stateDB.setFile(withoutLocalSignature(base));
  deps.queueRetry(path);
}
