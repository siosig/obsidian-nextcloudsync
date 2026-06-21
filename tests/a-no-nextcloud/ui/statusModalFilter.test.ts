import {
  ALL_FILTER_OPS,
  isVisible,
  filterReport,
  makeDefaultFilterState,
  SyncStatusReport,
} from '../../../src/ui/statusFilter';
import { SyncFileOp, SyncHistoryEntry } from '../../../src/types';

function hist(path: string, op: SyncFileOp, at = 1000): SyncHistoryEntry {
  return { path, op, at };
}

function makeReport(): SyncStatusReport {
  return {
    summary: {
      startedAt: 0,
      completedAt: 1,
      uploadedCount: 1,
      downloadedCount: 1,
      deletedCount: 0,
      mergedCount: 0,
      conflictedCount: 1,
      errorCount: 1,
      retriedFiles: [],
      errors: [{ path: 'err.md', message: 'boom' }],
    },
    conflictedFiles: ['c.md'],
    retryFiles: ['r.md'],
    history: [
      hist('a.md', 'uploaded'),
      hist('b.md', 'downloaded'),
      hist('c.md', 'conflicted'),
      hist('e.md', 'error'),
    ],
  };
}

describe('SyncStatusModal status filter', () => {
  test('F1: default state has all ops checked and shows every entry', () => {
    const state = makeDefaultFilterState();
    expect(state.checked.size).toBe(ALL_FILTER_OPS.length);
    const f = filterReport(makeReport(), state.checked);
    expect(f.history).toHaveLength(4);
    expect(f.conflictedFiles).toEqual(['c.md']);
    expect(f.retryFiles).toEqual(['r.md']);
    expect(f.errors).toHaveLength(1);
  });

  test('F2: unchecking "uploaded" hides uploaded history; other ops remain', () => {
    const checked = makeDefaultFilterState().checked;
    checked.delete('uploaded');
    const f = filterReport(makeReport(), checked);
    expect(f.history.map(e => e.op)).not.toContain('uploaded');
    expect(f.history.map(e => e.op)).toEqual(['downloaded', 'conflicted', 'error']);
    expect(isVisible('uploaded', checked)).toBe(false);
    expect(isVisible('downloaded', checked)).toBe(true);
  });

  test('F3: re-checking "uploaded" restores its rows', () => {
    const checked = makeDefaultFilterState().checked;
    checked.delete('uploaded');
    checked.add('uploaded');
    const f = filterReport(makeReport(), checked);
    expect(f.history.map(e => e.op)).toContain('uploaded');
  });

  test('conflicts section governed by "conflicted"; retry & errors by "error"', () => {
    const checked = makeDefaultFilterState().checked;
    checked.delete('conflicted');
    let f = filterReport(makeReport(), checked);
    expect(f.conflictedFiles).toEqual([]);
    expect(f.retryFiles).toEqual(['r.md']); // unaffected by 'conflicted'
    expect(f.errors).toHaveLength(1);

    checked.delete('error');
    f = filterReport(makeReport(), checked);
    expect(f.retryFiles).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  test('F4: unchecking everything yields empty sections (no throw)', () => {
    const checked = new Set<SyncFileOp>();
    const f = filterReport(makeReport(), checked);
    expect(f.history).toEqual([]);
    expect(f.conflictedFiles).toEqual([]);
    expect(f.retryFiles).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  test('F5: ALL_FILTER_OPS lists every SyncFileOp so each gets a checkbox', () => {
    const expected: SyncFileOp[] = [
      'uploaded', 'downloaded', 'deleted', 'merged', 'conflicted', 'local-wins', 'remote-wins', 'error',
    ];
    expect([...ALL_FILTER_OPS].sort()).toEqual([...expected].sort());
  });
});
