import { resolveConcurrencyDefault } from '../../src/util/limits';

describe('resolveConcurrencyDefault', () => {
  it('falls back to 3 when device memory is unknown (e.g. iOS WKWebView)', () => {
    expect(resolveConcurrencyDefault(undefined)).toBe(3);
  });
  it('gives a typical desktop (deviceMemory caps at 8) the established default of 16', () => {
    expect(resolveConcurrencyDefault(8)).toBe(16);
  });
  it('scales mid-range devices', () => {
    expect(resolveConcurrencyDefault(4)).toBe(8);
  });
  it('keeps low-memory devices conservative', () => {
    expect(resolveConcurrencyDefault(2)).toBe(4);
  });
});
