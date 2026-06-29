// [SPEC:SNI-1..SNI-4] specs/036-slider-numeric-input — editable numeric input normalization.
// normalizeNumericInput clamps to the slider range, rounds to an integer, and reverts invalid input
// (empty / NaN / non-numeric) to the last valid value so a bad keystroke never corrupts the setting.
import { normalizeNumericInput } from '../../../src/util/numericInput';

describe('[SPEC:SNI-1] out-of-range clamps to the slider bounds', () => {
  it('above max → max', () => {
    expect(normalizeNumericInput('5000', 0, 2048, 0)).toBe(2048);
  });
  it('below min → min', () => {
    expect(normalizeNumericInput('5', 15, 120, 30)).toBe(15);
  });
  it('negative → min', () => {
    expect(normalizeNumericInput('-7', 0, 60, 16)).toBe(0);
  });
});

describe('[SPEC:SNI-2] invalid input reverts to the current value', () => {
  it('empty → current', () => {
    expect(normalizeNumericInput('', 0, 2048, 20)).toBe(20);
  });
  it('whitespace only → current', () => {
    expect(normalizeNumericInput('   ', 0, 60, 3)).toBe(3);
  });
  it('non-numeric → current', () => {
    expect(normalizeNumericInput('abc', 0, 2048, 25)).toBe(25);
  });
});

describe('[SPEC:SNI-3] off-grid integers in range are accepted as-is', () => {
  it.each([
    [25, 0, 2048],   // maxFileSize off the step-16 grid
    [3, 0, 60],      // concurrency off the step-4 grid
    [20, 0, 2048],   // mobile maxFileSize default (off-grid)
    [35, 0, 100],    // arbitrary in-range integer
  ])('value %i in [%i,%i] stays itself', (v, min, max) => {
    expect(normalizeNumericInput(String(v), min, max, 0)).toBe(v);
  });
});

describe('[SPEC:SNI-4] decimals are rounded to integers (then clamped)', () => {
  it('25.7 → 26', () => {
    expect(normalizeNumericInput('25.7', 0, 2048, 0)).toBe(26);
  });
  it('2.2 → 2', () => {
    expect(normalizeNumericInput('2.2', 0, 60, 0)).toBe(2);
  });
  it('rounds then clamps: 2047.9 within max', () => {
    expect(normalizeNumericInput('2047.9', 0, 2048, 0)).toBe(2048);
  });
});

describe('boundary values are allowed', () => {
  it('exactly min', () => {
    expect(normalizeNumericInput('15', 15, 120, 30)).toBe(15);
  });
  it('exactly max', () => {
    expect(normalizeNumericInput('100', 0, 100, 0)).toBe(100);
  });
  it('zero where 0 is meaningful (unlimited/off)', () => {
    expect(normalizeNumericInput('0', 0, 2048, 20)).toBe(0);
  });
});
