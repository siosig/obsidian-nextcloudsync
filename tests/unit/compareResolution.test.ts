import { RESOLUTION_STRATEGIES, CompareEngine } from '../../src/ui/compareResolution';
import { RemoteCompareResult } from '../../src/types';

function result(over: Partial<RemoteCompareResult>): RemoteCompareResult {
  return {
    path: 'a.md', state: 'ok', localExists: true, remoteExists: true,
    localMtime: 1, remoteMtime: 2, localChecksum: 'x', remoteChecksum: 'y',
    checksumMatch: false, localText: 'l', remoteText: 'r', diffAvailable: true,
    localSize: 1, remoteSize: 1, ...over,
  };
}

const byId = (id: string) => RESOLUTION_STRATEGIES.find(s => s.id === id)!;

describe('compare resolution strategies', () => {
  test('push applies only when a local file exists; pull only when a remote exists', () => {
    expect(byId('push').isApplicable(result({ localExists: true }))).toBe(true);
    expect(byId('push').isApplicable(result({ localExists: false }))).toBe(false);
    expect(byId('pull').isApplicable(result({ remoteExists: true }))).toBe(true);
    expect(byId('pull').isApplicable(result({ remoteExists: false }))).toBe(false);
  });

  test('remote-missing result offers push only (no pull)', () => {
    const r = result({ state: 'remote-missing', remoteExists: false, localExists: true });
    const applicable = RESOLUTION_STRATEGIES.filter(s => s.isApplicable(r)).map(s => s.id);
    expect(applicable).toEqual(['push']);
  });

  test('execute delegates to the matching engine method', async () => {
    const calls: string[] = [];
    const engine: CompareEngine = {
      compareWithRemote: async () => result({}),
      pushLocalToRemote: async (p) => { calls.push(`push:${p}`); },
      pullRemoteToLocal: async (p) => { calls.push(`pull:${p}`); },
    };
    await byId('push').execute(engine, 'a.md');
    await byId('pull').execute(engine, 'a.md');
    expect(calls).toEqual(['push:a.md', 'pull:a.md']);
  });

  test('each strategy provides a destructive confirmation', () => {
    for (const s of RESOLUTION_STRATEGIES) {
      const opts = s.confirmOptions('a.md');
      expect(opts.destructive).toBe(true);
      expect(opts.message).toContain('a.md');
    }
  });
});
