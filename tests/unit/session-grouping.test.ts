import { groupByRun } from '../../src/ui/statusFilter';
import { SyncHistoryEntry } from '../../src/types';

const e = (path: string, at: number, runStartedAt?: number): SyncHistoryEntry =>
  ({ path, op: 'uploaded', at, ...(runStartedAt !== undefined ? { runStartedAt } : {}) });

describe('groupByRun (US2 session grouping)', () => {
  it('returns [] for empty input', () => {
    expect(groupByRun([])).toEqual([]);
  });

  it('groups entries of two runs, newest run first', () => {
    const groups = groupByRun([
      e('a.md', 1005, 1000),
      e('b.md', 1002, 1000),
      e('c.md', 2003, 2000),
    ]);
    expect(groups.map(g => g.runStartedAt)).toEqual([2000, 1000]); // newest run first
    expect(groups[0].entries.map(x => x.path)).toEqual(['c.md']);
    // within a group, newest entry first
    expect(groups[1].entries.map(x => x.path)).toEqual(['a.md', 'b.md']);
  });

  it('puts a single run into one group', () => {
    const groups = groupByRun([e('a.md', 1001, 1000), e('b.md', 1002, 1000)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].runStartedAt).toBe(1000);
  });

  it('groups legacy entries (no runStartedAt) by their own at — one group each', () => {
    const groups = groupByRun([e('a.md', 500), e('b.md', 700)]);
    expect(groups.map(g => g.runStartedAt)).toEqual([700, 500]);
    expect(groups.every(g => g.entries.length === 1)).toBe(true);
  });

  it('handles a mix of tagged and legacy entries', () => {
    const groups = groupByRun([e('a.md', 1001, 1000), e('legacy.md', 900)]);
    expect(groups.map(g => g.runStartedAt)).toEqual([1000, 900]);
  });
});
