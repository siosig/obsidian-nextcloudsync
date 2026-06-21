// Spec-conformance: 016-sync-status-ui + 013-sync-status-filter (pure logic FRs).
// Dialog rendering / explorer menu are UI (manual checklist); here we assert the
// pure helpers: 24-hour time formatting, run grouping, filter persistence.
import { formatClock24 } from '../../../src/ui/timeFormat';
import {
  serializeFilter, deserializeFilter, makeDefaultFilterState, groupByRun, ALL_FILTER_OPS,
} from '../../../src/ui/statusFilter';
import { SyncHistoryEntry } from '../../../src/types';

describe('spec 016 — status dialog (pure logic)', () => {
  it('FR-009: same-day timestamp formats as 24-hour HH:mm', () => {
    const now = new Date(2026, 5, 21, 14, 30).getTime();
    const at = new Date(2026, 5, 21, 9, 5).getTime();
    expect(formatClock24(at, now)).toBe('09:05');
  });

  it('FR-010: different-day timestamp is date-disambiguated (MM-DD HH:mm)', () => {
    const now = new Date(2026, 5, 21, 14, 30).getTime();
    const at = new Date(2026, 5, 19, 23, 50).getTime();
    expect(formatClock24(at, now)).toBe('06-19 23:50');
  });

  it('FR-005: recent activity groups newest-run-first', () => {
    const entries: SyncHistoryEntry[] = [
      { path: 'a', op: 'uploaded', at: 100, runStartedAt: 100 },
      { path: 'b', op: 'uploaded', at: 200, runStartedAt: 200 },
    ];
    const groups = groupByRun(entries);
    expect(groups[0].runStartedAt).toBe(200);
    expect(groups[1].runStartedAt).toBe(100);
  });

  it('FR-011: filter selection round-trips through serialize/deserialize', () => {
    const s = makeDefaultFilterState();
    s.checked.delete('uploaded');
    const restored = deserializeFilter(serializeFilter(s));
    expect(restored.checked.has('uploaded')).toBe(false);
    expect(restored.checked.has('downloaded')).toBe(true);
  });

  it('FR-012: no saved selection ⇒ all statuses checked', () => {
    expect(deserializeFilter(undefined).checked.size).toBe(ALL_FILTER_OPS.length);
  });

  it('FR-014: unknown status keys are ignored on load', () => {
    const restored = deserializeFilter(['uploaded', 'bogus-status']);
    expect(restored.checked.has('uploaded')).toBe(true);
    expect([...restored.checked]).not.toContain('bogus-status');
  });
});
