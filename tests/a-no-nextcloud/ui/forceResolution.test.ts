import { applyForceResolution, applyBulkForceResolution, FORCE_CHOICES, ForceChoice } from '../../../src/ui/forceResolution';
import { CompareEngine } from '../../../src/ui/compareResolution';
import { RemoteCompareResult, SyncFileOp } from '../../../src/types';
import { filterReport, SyncStatusReport, ALL_FILTER_OPS } from '../../../src/ui/statusFilter';

// A fake CompareEngine that records which overwrite path ran and serves a scripted compare result.
// Feature 041: applyForceResolution must reduce every choice to push (local wins) / pull (remote wins)
// or a no-op (tie), and must propagate overwrite failures so the caller keeps the file conflicted.
function makeEngine(compare: Partial<RemoteCompareResult> = {}, opts: { failPush?: boolean; failPull?: boolean } = {}) {
  const calls: string[] = [];
  const engine: CompareEngine = {
    async compareWithRemote(path: string): Promise<RemoteCompareResult> {
      calls.push('compare');
      return {
        path, state: 'ok', localExists: true, remoteExists: true,
        localMtime: null, remoteMtime: null, localChecksum: 'a', remoteChecksum: 'b',
        checksumMatch: false, localText: null, remoteText: null, diffAvailable: false,
        localSize: null, remoteSize: null,
        ...compare,
      };
    },
    async pushLocalToRemote(): Promise<void> {
      calls.push('push');
      if (opts.failPush) throw new Error('push failed');
    },
    async pullRemoteToLocal(): Promise<void> {
      calls.push('pull');
      if (opts.failPull) throw new Error('pull failed');
    },
  };
  return { engine, calls };
}

describe('forceResolution — choices', () => {
  it('FORCE_CHOICES lists the four options in order', () => {
    expect(FORCE_CHOICES.map(c => c.id)).toEqual<ForceChoice[]>(['remote', 'local', 'latest', 'biggest']);
  });

  it('[SPEC:FRC-1] remote → pull (overwrite local with remote)', async () => {
    const { engine, calls } = makeEngine();
    expect(await applyForceResolution(engine, 'n.md', 'remote')).toBe('applied');
    expect(calls).toEqual(['pull']);
  });

  it('[SPEC:FRC-2] local → push (overwrite remote with local)', async () => {
    const { engine, calls } = makeEngine();
    expect(await applyForceResolution(engine, 'n.md', 'local')).toBe('applied');
    expect(calls).toEqual(['push']);
  });
});

describe('forceResolution — latest modified', () => {
  it('[SPEC:FRC-3] local newer → push', async () => {
    const { engine, calls } = makeEngine({ localMtime: 3000, remoteMtime: 1000 });
    expect(await applyForceResolution(engine, 'n.md', 'latest')).toBe('applied');
    expect(calls).toEqual(['compare', 'push']);
  });

  it('[SPEC:FRC-3] remote newer → pull', async () => {
    const { engine, calls } = makeEngine({ localMtime: 1000, remoteMtime: 3000 });
    expect(await applyForceResolution(engine, 'n.md', 'latest')).toBe('applied');
    expect(calls).toEqual(['compare', 'pull']);
  });

  it('[SPEC:FRC-5] equal mtime → no-op, no overwrite', async () => {
    const { engine, calls } = makeEngine({ localMtime: 5000, remoteMtime: 5000 });
    expect(await applyForceResolution(engine, 'n.md', 'latest')).toBe('noop');
    expect(calls).toEqual(['compare']); // neither push nor pull
  });
});

describe('forceResolution — biggest size', () => {
  it('[SPEC:FRC-4] local bigger → push', async () => {
    const { engine, calls } = makeEngine({ localSize: 200, remoteSize: 100 });
    expect(await applyForceResolution(engine, 'n.md', 'biggest')).toBe('applied');
    expect(calls).toEqual(['compare', 'push']);
  });

  it('[SPEC:FRC-4] remote bigger → pull', async () => {
    const { engine, calls } = makeEngine({ localSize: 100, remoteSize: 200 });
    expect(await applyForceResolution(engine, 'n.md', 'biggest')).toBe('applied');
    expect(calls).toEqual(['compare', 'pull']);
  });

  it('[SPEC:FRC-5] equal size → no-op, no overwrite', async () => {
    const { engine, calls } = makeEngine({ localSize: 42, remoteSize: 42 });
    expect(await applyForceResolution(engine, 'n.md', 'biggest')).toBe('noop');
    expect(calls).toEqual(['compare']);
  });
});

describe('forceResolution — missing side & failure propagation', () => {
  it('latest with only remote present → pull', async () => {
    const { engine, calls } = makeEngine({ localMtime: null, remoteMtime: 1000 });
    expect(await applyForceResolution(engine, 'n.md', 'latest')).toBe('applied');
    expect(calls).toEqual(['compare', 'pull']);
  });

  it('biggest with only local present → push', async () => {
    const { engine, calls } = makeEngine({ localSize: 100, remoteSize: null });
    expect(await applyForceResolution(engine, 'n.md', 'biggest')).toBe('applied');
    expect(calls).toEqual(['compare', 'push']);
  });

  it('both sides absent → no-op', async () => {
    const { engine, calls } = makeEngine({ localMtime: null, remoteMtime: null });
    expect(await applyForceResolution(engine, 'n.md', 'latest')).toBe('noop');
    expect(calls).toEqual(['compare']);
  });

  it('[SPEC:FRC-6] propagates a push failure (caller keeps the file conflicted)', async () => {
    const { engine } = makeEngine({}, { failPush: true });
    await expect(applyForceResolution(engine, 'n.md', 'local')).rejects.toThrow('push failed');
  });

  it('[SPEC:FRC-6] propagates a pull failure', async () => {
    const { engine } = makeEngine({}, { failPull: true });
    await expect(applyForceResolution(engine, 'n.md', 'remote')).rejects.toThrow('pull failed');
  });
});

// Feature 042: applyBulkForceResolution — a purely sequential fan-out over applyForceResolution that
// never rejects and tallies resolved/noop/failed. Unlike `makeEngine` above (which records only the
// operation name), BRC-2 (sequential order) and BRC-3 (partial failure) need to know WHICH path each
// call belongs to, so this fake records `${op}:${path}` and lets each path be scripted independently
// (per-path compare result / per-path push-or-pull failure). `makeEngine` is left untouched so the
// existing FRC-* tests above keep passing unmodified.
interface RecordingEngineConfig {
  compare?: Partial<RemoteCompareResult>;
  failPush?: boolean;
  failPull?: boolean;
}

function makeRecordingEngine(perPath: Record<string, RecordingEngineConfig> = {}) {
  const calls: string[] = [];
  const engine: CompareEngine = {
    async compareWithRemote(path: string): Promise<RemoteCompareResult> {
      calls.push(`compare:${path}`);
      const cfg = perPath[path] ?? {};
      return {
        path, state: 'ok', localExists: true, remoteExists: true,
        localMtime: null, remoteMtime: null, localChecksum: 'a', remoteChecksum: 'b',
        checksumMatch: false, localText: null, remoteText: null, diffAvailable: false,
        localSize: null, remoteSize: null,
        ...cfg.compare,
      };
    },
    async pushLocalToRemote(path: string): Promise<void> {
      calls.push(`push:${path}`);
      const cfg = perPath[path] ?? {};
      if (cfg.failPush) throw new Error(`push failed: ${path}`);
    },
    async pullRemoteToLocal(path: string): Promise<void> {
      calls.push(`pull:${path}`);
      const cfg = perPath[path] ?? {};
      if (cfg.failPull) throw new Error(`pull failed: ${path}`);
    },
  };
  return { engine, calls };
}

// Feature 044: when the engine exposes a clean-side snapshot for a path, force-resolution must recover
// from it (applyCleanRemote/applyCleanLocal) instead of the current-content pull/push; Latest/Biggest
// dispatch by the snapshot metrics. When no snapshot exists, every choice falls back to the legacy
// pull/push behavior (proven by all the FRC-* tests above, whose fake has none of these methods).
function makeSnapshotEngine(
  metrics: { localMtime: number; remoteMtime: number; localSize: number; remoteSize: number } | null,
) {
  const calls: string[] = [];
  const engine: CompareEngine = {
    async compareWithRemote(path: string): Promise<RemoteCompareResult> {
      calls.push('compare');
      return {
        path, state: 'ok', localExists: true, remoteExists: true,
        localMtime: 9999, remoteMtime: 9999, localChecksum: 'a', remoteChecksum: 'b',
        checksumMatch: false, localText: null, remoteText: null, diffAvailable: false,
        localSize: 9999, remoteSize: 9999,
      };
    },
    async pushLocalToRemote(): Promise<void> { calls.push('push'); },
    async pullRemoteToLocal(): Promise<void> { calls.push('pull'); },
    cleanSideMetrics: () => metrics,
    async applyCleanRemote(): Promise<void> { calls.push('applyCleanRemote'); },
    async applyCleanLocal(): Promise<void> { calls.push('applyCleanLocal'); },
  };
  return { engine, calls };
}

describe('forceResolution — clean-side snapshot recovery (feature 044)', () => {
  const M = { localMtime: 3000, remoteMtime: 1000, localSize: 200, remoteSize: 100 };

  it('[SPEC:CSS-2] remote → recover the clean remote (not a plain pull) when a snapshot exists', async () => {
    const { engine, calls } = makeSnapshotEngine(M);
    expect(await applyForceResolution(engine, 'n.md', 'remote')).toBe('applied');
    expect(calls).toEqual(['applyCleanRemote']);
  });

  it('[SPEC:CSS-2] local → recover the clean local (not a plain push) when a snapshot exists', async () => {
    const { engine, calls } = makeSnapshotEngine(M);
    expect(await applyForceResolution(engine, 'n.md', 'local')).toBe('applied');
    expect(calls).toEqual(['applyCleanLocal']);
  });

  it('[SPEC:CSS-3] latest dispatches by SNAPSHOT metrics (local newer → clean local), no compare call', async () => {
    const { engine, calls } = makeSnapshotEngine(M); // localMtime 3000 > remoteMtime 1000
    expect(await applyForceResolution(engine, 'n.md', 'latest')).toBe('applied');
    expect(calls).toEqual(['applyCleanLocal']); // NOT ['compare', ...] — the snapshot metrics win
  });

  it('[SPEC:CSS-3] biggest dispatches by SNAPSHOT metrics (remote bigger → clean remote)', async () => {
    const { engine, calls } = makeSnapshotEngine({ localMtime: 0, remoteMtime: 0, localSize: 100, remoteSize: 200 });
    expect(await applyForceResolution(engine, 'n.md', 'biggest')).toBe('applied');
    expect(calls).toEqual(['applyCleanRemote']);
  });

  it('[SPEC:CSS-3] equal snapshot metric → no-op (no recovery, no overwrite)', async () => {
    const { engine, calls } = makeSnapshotEngine({ localMtime: 5, remoteMtime: 5, localSize: 5, remoteSize: 5 });
    expect(await applyForceResolution(engine, 'n.md', 'latest')).toBe('noop');
    expect(calls).toEqual([]);
  });

  it('[SPEC:CSS-5] no snapshot (metrics null) → legacy pull/push fallback', async () => {
    const { engine, calls } = makeSnapshotEngine(null);
    expect(await applyForceResolution(engine, 'n.md', 'remote')).toBe('applied');
    expect(calls).toEqual(['pull']); // falls back to the current-content pull, never applyCleanRemote
  });
});

describe('forceResolution — bulk', () => {
  it('[SPEC:BRC-5] empty paths → {0,0,0}, engine untouched', async () => {
    const { engine, calls } = makeEngine();
    const result = await applyBulkForceResolution(engine, [], 'remote');
    expect(result).toEqual({ resolved: 0, noop: 0, failed: 0 });
    expect(calls).toEqual([]);
  });

  it('[SPEC:BRC-6] N=1 applied → tallies into a single resolved bucket matching per-file outcome', async () => {
    const { engine, calls } = makeEngine();
    const result = await applyBulkForceResolution(engine, ['n.md'], 'local');
    expect(result).toEqual({ resolved: 1, noop: 0, failed: 0 });
    expect(calls).toEqual(['push']);
  });

  it('[SPEC:BRC-6] N=1 tie → tallies into a single noop bucket matching per-file outcome', async () => {
    const { engine } = makeEngine({ localMtime: 5000, remoteMtime: 5000 });
    const result = await applyBulkForceResolution(engine, ['n.md'], 'latest');
    expect(result).toEqual({ resolved: 0, noop: 1, failed: 0 });
  });

  it('[SPEC:BRC-1][SPEC:BRC-4] mixed applied/noop outcomes match per-file resolution and satisfy the invariant', async () => {
    const config: Record<string, RecordingEngineConfig> = {
      'a.md': { compare: { localMtime: 3000, remoteMtime: 1000 } }, // local newer -> push/applied
      'b.md': { compare: { localMtime: 5000, remoteMtime: 5000 } }, // tie -> noop
      'c.md': { compare: { localMtime: 1000, remoteMtime: 3000 } }, // remote newer -> pull/applied
    };
    const paths = ['a.md', 'b.md', 'c.md'];
    const { engine } = makeRecordingEngine(config);

    const result = await applyBulkForceResolution(engine, paths, 'latest');
    expect(result).toEqual({ resolved: 2, noop: 1, failed: 0 });
    expect(result.resolved + result.noop + result.failed).toBe(paths.length);

    // Equivalence: each path's bulk outcome matches what applyForceResolution would produce alone,
    // given a fresh engine scripted identically (BRC-1).
    for (const path of paths) {
      const { engine: singleEngine } = makeRecordingEngine(config);
      const outcome = await applyForceResolution(singleEngine, path, 'latest');
      expect(outcome).toBe(path === 'b.md' ? 'noop' : 'applied');
    }
  });

  it('[SPEC:BRC-2] processes paths sequentially in paths order (each file completes before the next starts)', async () => {
    const config: Record<string, RecordingEngineConfig> = {
      'a.md': { compare: { localMtime: 2, remoteMtime: 1 } },
      'b.md': { compare: { localMtime: 2, remoteMtime: 1 } },
      'c.md': { compare: { localMtime: 2, remoteMtime: 1 } },
    };
    const { engine, calls } = makeRecordingEngine(config);
    const result = await applyBulkForceResolution(engine, ['a.md', 'b.md', 'c.md'], 'latest');
    expect(result).toEqual({ resolved: 3, noop: 0, failed: 0 });
    // If execution were parallel, compare calls for later files could interleave before earlier
    // files' push calls; strict per-file completion order proves sequential (not parallel) dispatch.
    expect(calls).toEqual([
      'compare:a.md', 'push:a.md',
      'compare:b.md', 'push:b.md',
      'compare:c.md', 'push:c.md',
    ]);
  });

  it('[SPEC:BRC-3] a mid-batch failure is counted as failed and the batch continues to later paths', async () => {
    const { engine, calls } = makeRecordingEngine({ 'b.md': { failPush: true } });
    const result = await applyBulkForceResolution(engine, ['a.md', 'b.md', 'c.md'], 'local');
    expect(result).toEqual({ resolved: 2, noop: 0, failed: 1 });
    expect(result.resolved + result.noop + result.failed).toBe(3);
    // b.md's push call still ran (and is recorded) before throwing; c.md was still processed after.
    expect(calls).toEqual(['push:a.md', 'push:b.md', 'push:c.md']);
  });

  it('[SPEC:BRC-3] a mid-batch pull failure is counted as failed and the batch continues', async () => {
    const { engine, calls } = makeRecordingEngine({ 'b.md': { failPull: true } });
    const result = await applyBulkForceResolution(engine, ['a.md', 'b.md', 'c.md'], 'remote');
    expect(result).toEqual({ resolved: 2, noop: 0, failed: 1 });
    expect(calls).toEqual(['pull:a.md', 'pull:b.md', 'pull:c.md']);
  });

  it('[SPEC:BRC-7] every path failing → {resolved:0, noop:0, failed:N} and the promise never rejects', async () => {
    const { engine } = makeRecordingEngine({
      'a.md': { failPush: true },
      'b.md': { failPush: true },
    });
    const paths = ['a.md', 'b.md'];
    await expect(applyBulkForceResolution(engine, paths, 'local')).resolves.toEqual({
      resolved: 0, noop: 0, failed: 2,
    });
  });

  it('[SPEC:BRC-9] FR-007/SC-005: a filterReport-derived subset of paths touches only that subset', async () => {
    const report: SyncStatusReport = {
      summary: null,
      conflictedFiles: ['a.md', 'b.md', 'c.md', 'd.md'],
      retryFiles: [],
      history: [],
    };
    const checked = new Set<SyncFileOp>(ALL_FILTER_OPS); // all statuses visible, including 'conflicted'
    const filtered = filterReport(report, checked);
    expect(filtered.conflictedFiles).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);

    const paths = filtered.conflictedFiles.slice(0, 2); // caller-chosen subset: a.md, b.md only
    const { engine, calls } = makeRecordingEngine();
    const result = await applyBulkForceResolution(engine, paths, 'local');

    expect(result).toEqual({ resolved: 2, noop: 0, failed: 0 });
    expect(calls).toEqual(['push:a.md', 'push:b.md']);
    expect(calls.some(c => c.includes('c.md') || c.includes('d.md'))).toBe(false);
  });
});
