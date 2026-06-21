// Verifies the shared fixture set matches the real-world file-mix assumption:
// markdown >= 90% of files, large binaries (pdf/image) < 10% (FR-017 / SC-007).
import { fixtureRatio, FIXTURES } from '../../fixtures';

describe('[SPEC:FR-017] fixture file-mix distribution (md-heavy)', () => {
  it('markdown is at least 90% of fixtures', () => {
    expect(fixtureRatio().mdRatio).toBeGreaterThanOrEqual(0.9);
  });

  it('large binaries are less than 10% of fixtures', () => {
    expect(fixtureRatio().largeRatio).toBeLessThan(0.1);
  });

  it('preserves the international (Japanese) functional fixture path', () => {
    expect(FIXTURES.some((f) => f.path.includes('メモ'))).toBe(true);
  });
});
