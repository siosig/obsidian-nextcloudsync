import { formatSkippedPathsForDisplay } from '../../../src/ui/SyncStatusModal';

describe('[SPEC:MDV-3] formatSkippedPathsForDisplay', () => {
  test('sample matches totalCount exactly: returns sample as-is, no "more" line', () => {
    const sample = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    const result = formatSkippedPathsForDisplay(sample, 5);
    expect(result).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
    expect(result).toHaveLength(5);
  });

  test('sample capped at 10, totalCount 23: appends "…and 13 more"', () => {
    const sample = Array.from({ length: 10 }, (_, i) => `note-${i}.md`);
    const result = formatSkippedPathsForDisplay(sample, 23);
    expect(result).toHaveLength(11);
    expect(result.slice(0, 10)).toEqual(sample);
    expect(result[10]).toBe('…and 13 more');
  });

  test('empty sample and zero totalCount: returns empty array', () => {
    const result = formatSkippedPathsForDisplay([], 0);
    expect(result).toEqual([]);
  });

  test('boundary: sample at cap (10) with totalCount also 10: no "more" line appended', () => {
    const sample = Array.from({ length: 10 }, (_, i) => `note-${i}.md`);
    const result = formatSkippedPathsForDisplay(sample, 10);
    expect(result).toEqual(sample);
    expect(result).toHaveLength(10);
  });
});
