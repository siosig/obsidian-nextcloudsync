// Feature 041: per-file force resolution for the Sync status dialog's conflict list. Each conflicted
// file can be forced to a decisive outcome — take remote, take local, take the newer side, or take the
// bigger side — executed immediately (not deferred to the next sync). This is a one-shot manual
// recovery action on an already-conflicted file, NOT a persistent setting (spec 041, FR-017).
//
// All four choices reduce to the two existing single-file overwrite paths: pushLocalToRemote (local
// wins) and pullRemoteToLocal (remote wins). `latest` / `biggest` are a thin dispatch that compares
// the two sides' modification time / size (from compareWithRemote) and picks one of those two paths.
// The module depends on the narrow CompareEngine abstraction (shared with the compare popup) rather
// than the concrete SyncEngine, so it stays pure-ish and unit-testable (DIP).

import { CompareEngine } from './compareResolution';

/** The four force-resolution choices offered per conflicted file. */
export type ForceChoice = 'remote' | 'local' | 'latest' | 'biggest';

/** Choices in dropdown display order, with their human labels. */
export const FORCE_CHOICES: readonly { id: ForceChoice; label: string }[] = [
  { id: 'remote', label: 'Use remote' },
  { id: 'local', label: 'Use local' },
  { id: 'latest', label: 'Latest modified' },
  { id: 'biggest', label: 'Biggest size' },
];

/**
 * `applied` — an overwrite was performed and the conflict resolved.
 * `noop` — the two sides tied on the chosen metric (equal mtime / equal size), so nothing was done and
 * (per FR-012) no notice is shown. The caller leaves the file conflicted.
 */
export type ForceOutcome = 'applied' | 'noop';

/**
 * Execute the chosen force resolution now. Rejects if the underlying overwrite fails (upload/download
 * failure, size limit, lock) — the caller surfaces the error and keeps the file conflicted (FR-015).
 */
export async function applyForceResolution(
  engine: CompareEngine,
  path: string,
  choice: ForceChoice,
): Promise<ForceOutcome> {
  // Feature 044: when a clean-side snapshot exists for this path (a marker conflict that overwrote both
  // clean sides), recover from it instead of the current (marker-corrupted) server/local content. When
  // no snapshot exists (safe-hold / size-hold, pre-044 conflicts, Compare popup callers) every branch
  // falls back to the original compare/push/pull behavior — so nothing else changes.
  const snap = engine.cleanSideMetrics?.(path) ?? null;
  switch (choice) {
    case 'remote':
      await useRemote(engine, path, snap);
      return 'applied';
    case 'local':
      await useLocal(engine, path, snap);
      return 'applied';
    case 'latest': {
      if (snap) return dispatchCleanByMetric(engine, path, snap.localMtime, snap.remoteMtime);
      const r = await engine.compareWithRemote(path);
      return dispatchByMetric(engine, path, r.localMtime, r.remoteMtime);
    }
    case 'biggest': {
      if (snap) return dispatchCleanByMetric(engine, path, snap.localSize, snap.remoteSize);
      const r = await engine.compareWithRemote(path);
      return dispatchByMetric(engine, path, r.localSize, r.remoteSize);
    }
  }
}

/** "Use remote": recover the captured clean remote if a snapshot exists, else pull the current remote. */
async function useRemote(engine: CompareEngine, path: string, snap: unknown): Promise<void> {
  if (snap && engine.applyCleanRemote) await engine.applyCleanRemote(path);
  else await engine.pullRemoteToLocal(path);
}

/** "Use local": recover the captured clean local if a snapshot exists, else push the current local. */
async function useLocal(engine: CompareEngine, path: string, snap: unknown): Promise<void> {
  if (snap && engine.applyCleanLocal) await engine.applyCleanLocal(path);
  else await engine.pushLocalToRemote(path);
}

/**
 * Latest/Biggest dispatch over the CLEAN-side metrics (feature 044): apply the clean local or clean
 * remote side by comparing the snapshot's mtime/size. Equal metric → no-op (FR-012), symmetric with
 * the current-content dispatch below.
 */
async function dispatchCleanByMetric(
  engine: CompareEngine,
  path: string,
  localMetric: number,
  remoteMetric: number,
): Promise<ForceOutcome> {
  if (localMetric === remoteMetric) return 'noop';
  if (localMetric > remoteMetric) await engine.applyCleanLocal!(path);
  else await engine.applyCleanRemote!(path);
  return 'applied';
}

/**
 * Pick push (local wins) or pull (remote wins) by comparing a per-side metric (mtime for `latest`,
 * size for `biggest`). Equal metrics → no-op (FR-012). A missing side adopts the side that exists.
 */
async function dispatchByMetric(
  engine: CompareEngine,
  path: string,
  localMetric: number | null,
  remoteMetric: number | null,
): Promise<ForceOutcome> {
  if (localMetric === null && remoteMetric === null) return 'noop';
  if (remoteMetric === null) {
    await engine.pushLocalToRemote(path);
    return 'applied';
  }
  if (localMetric === null) {
    await engine.pullRemoteToLocal(path);
    return 'applied';
  }
  if (localMetric === remoteMetric) return 'noop'; // tie → do nothing, no notice (FR-012)
  if (localMetric > remoteMetric) {
    await engine.pushLocalToRemote(path);
    return 'applied';
  }
  await engine.pullRemoteToLocal(path);
  return 'applied';
}

/**
 * Feature 042: aggregate result of a bulk force-resolution over a target set. Every tally is derived
 * from the per-file `ForceOutcome` `applyForceResolution` would produce for that same path, so the
 * batch introduces no new resolution semantics — only sequencing and failure isolation.
 */
export interface BulkOutcome {
  /** Files where an overwrite ran and the conflict cleared (per-file ForceOutcome 'applied'). */
  resolved: number;
  /** Files that tied on the chosen metric ('noop') — no overwrite, left conflicted. */
  noop: number;
  /** Files whose per-file resolution threw — left conflicted (batch did not abort). */
  failed: number;
}

/**
 * Apply one force-resolution choice to every path in `paths`, SEQUENTIALLY, tallying the outcome.
 * Reuses `applyForceResolution` per file (no new resolution semantics) — each path gets exactly the
 * outcome a standalone `applyForceResolution(engine, path, choice)` call would produce (FR-005/BRC-1).
 * Processing is strictly sequential (FR-013/BRC-2): each file's push/pull settles before the next
 * file's resolution starts. A per-file rejection is caught and counted as `failed`; the batch
 * continues with the remaining paths (FR-013/BRC-3) — this function itself never rejects (FR-009/BRC-7).
 */
export async function applyBulkForceResolution(
  engine: CompareEngine,
  paths: string[],
  choice: ForceChoice,
): Promise<BulkOutcome> {
  const result: BulkOutcome = { resolved: 0, noop: 0, failed: 0 };
  for (const path of paths) {
    try {
      const outcome = await applyForceResolution(engine, path, choice);
      if (outcome === 'applied') result.resolved++;
      else result.noop++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
