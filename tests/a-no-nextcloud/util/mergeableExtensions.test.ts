import { parseMergeableExtensions, formatMergeableExtensions } from '../../../src/util/mergeableExtensions';

describe('parseMergeableExtensions (030 — auto-merge file types)', () => {
  it('splits on commas and whitespace, lowercases, and strips leading dots', () => {
    expect(parseMergeableExtensions('MD, .txt  py,.CPP')).toEqual(['md', 'txt', 'py', 'cpp']);
  });

  it('de-duplicates, preserving first appearance', () => {
    expect(parseMergeableExtensions('md, md, txt, MD')).toEqual(['md', 'txt']);
  });

  it('returns [] for an all-blank input (which disables auto-merge entirely)', () => {
    expect(parseMergeableExtensions('   ')).toEqual([]);
    expect(parseMergeableExtensions('')).toEqual([]);
    expect(parseMergeableExtensions(' , , ')).toEqual([]);
  });

  it('round-trips through formatMergeableExtensions', () => {
    expect(formatMergeableExtensions(['md', 'txt', 'py'])).toBe('md, txt, py');
    expect(parseMergeableExtensions(formatMergeableExtensions(['md', 'cpp']))).toEqual(['md', 'cpp']);
  });
});
