import { applyForceResolution, FORCE_CHOICES, ForceChoice } from '../../../src/ui/forceResolution';
import { CompareEngine } from '../../../src/ui/compareResolution';
import { RemoteCompareResult } from '../../../src/types';

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
