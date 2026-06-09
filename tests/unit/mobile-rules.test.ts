import { isOverFileSizeLimit, isCellularBlocked } from '../../src/util/limits';

describe('isOverFileSizeLimit (T021)', () => {
  const MB = 1024 * 1024;
  it.each([
    // bytes,            maxMB, expected
    [10 * MB, 20, false],   // under limit
    [25 * MB, 20, true],    // over limit
    [20 * MB, 20, false],   // exactly at limit is allowed
    [9999 * MB, 0, false],  // 0 = unlimited
    [9999 * MB, -1, false], // negative treated as unlimited
    [0, 20, false],         // empty file
  ])('bytes=%i max=%iMB → %s', (bytes, maxMB, expected) => {
    expect(isOverFileSizeLimit(bytes as number, maxMB as number)).toBe(expected);
  });
});

describe('isCellularBlocked (T024)', () => {
  it('blocks when wifi-only is on and connection is cellular (non-iOS)', () => {
    expect(isCellularBlocked(true, false, 'cellular')).toBe(true);
  });
  it('allows wifi / ethernet / unknown / undefined', () => {
    expect(isCellularBlocked(true, false, 'wifi')).toBe(false);
    expect(isCellularBlocked(true, false, 'ethernet')).toBe(false);
    expect(isCellularBlocked(true, false, 'unknown')).toBe(false);
    expect(isCellularBlocked(true, false, undefined)).toBe(false);
  });
  it('never blocks when the setting is off', () => {
    expect(isCellularBlocked(false, false, 'cellular')).toBe(false);
  });
  it('never blocks on iOS (network type undetectable → setting ignored)', () => {
    expect(isCellularBlocked(true, true, 'cellular')).toBe(false);
  });
});
