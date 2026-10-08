// One-shot manual recovery for an already-conflicted file, not a persistent setting.
// All choices reduce to pushLocalToRemote (local wins) and pullRemoteToLocal (remote wins); `latest`/`biggest`
// compare mtime/size via compareWithRemote. Depends on the narrow CompareEngine, not SyncEngine, to stay unit-testable.

import { CompareEngine } from './compareResolution';

export type ForceChoice = 'remote' | 'local' | 'latest' | 'biggest';

export const FORCE_CHOICES: readonly { id: ForceChoice; label: string }[] = [
  { id: 'remote', label: 'Use remote' },
  { id: 'local', label: 'Use local' },
  { id: 'latest', label: 'Latest modified' },
  { id: 'biggest', label: 'Biggest size' },
];

// 'noop' means the sides tied on the chosen metric: nothing is done, no notice is shown and the file stays conflicted.
export type ForceOutcome = 'applied' | 'noop';

// Rejects if the overwrite fails (upload/download failure, size limit, lock); the caller surfaces the error and keeps the file conflicted.
export async function applyForceResolution(
  engine: CompareEngine,
  path: string,
  choice: ForceChoice,
): Promise<ForceOutcome> {
  // With a clean-side snapshot (a marker conflict that overwrote both sides), recover from it rather than the
  // marker-corrupted current content; without one, fall back to compare/push/pull (docs/spec.md §6.4).
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

async function useRemote(engine: CompareEngine, path: string, snap: unknown): Promise<void> {
  if (snap && engine.applyCleanRemote) await engine.applyCleanRemote(path);
  else await engine.pullRemoteToLocal(path);
}

async function useLocal(engine: CompareEngine, path: string, snap: unknown): Promise<void> {
  if (snap && engine.applyCleanLocal) await engine.applyCleanLocal(path);
  else await engine.pushLocalToRemote(path);
}

// Compares the snapshot's clean-side mtime/size; an equal metric is a no-op, as in the current-content dispatch below.
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

// Equal metrics are a no-op; a missing side adopts the side that exists.
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
  if (localMetric === remoteMetric) return 'noop'; // tie: do nothing, no notice
  if (localMetric > remoteMetric) {
    await engine.pushLocalToRemote(path);
    return 'applied';
  }
  await engine.pullRemoteToLocal(path);
  return 'applied';
}

// Tallies derive from the per-file ForceOutcome, so batching adds only sequencing and failure isolation.
export interface BulkOutcome {
  resolved: number;
  noop: number;
  failed: number;
}

// Strictly sequential: each file's push/pull settles before the next starts. A per-file rejection is counted
// as `failed` and the batch continues; this function never rejects.
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
