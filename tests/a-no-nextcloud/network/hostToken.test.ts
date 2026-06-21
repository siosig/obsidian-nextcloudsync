import { hostToken, sanitizeHost } from '../../../src/util/hostToken';

describe('sanitizeHost', () => {
  it('replaces filesystem-reserved characters with "-"', () => {
    expect(sanitizeHost('home/laptop')).toBe('home-laptop');
    expect(sanitizeHost('a:b*c?d"e<f>g|h\\i')).toBe('a-b-c-d-e-f-g-h-i');
  });

  it('collapses whitespace runs and repeated separators, trims edges', () => {
    expect(sanitizeHost('  MacBook   Pro  ')).toBe('MacBook-Pro');
    expect(sanitizeHost('--a--b--')).toBe('a-b');
  });

  it('preserves non-ASCII characters', () => {
    expect(sanitizeHost('母艦')).toBe('母艦');
  });

  it('returns empty string when nothing usable remains', () => {
    expect(sanitizeHost('  /// ')).toBe('');
  });
});

describe('hostToken', () => {
  const deviceId = 'a1b2c3d4-5e6f-7890-abcd-ef1234567890';

  it('uses the sanitized device name when provided', () => {
    expect(hostToken('My Laptop', 'desktop', deviceId)).toBe('My-Laptop');
  });

  it('falls back to "<platform>-<deviceId6>" when device name is blank', () => {
    expect(hostToken('', 'desktop', deviceId)).toBe('desktop-a1b2c3');
    expect(hostToken('   ', 'ios', deviceId)).toBe('ios-a1b2c3');
  });

  it('falls back to the default when the device name sanitizes to empty', () => {
    expect(hostToken('///', 'android', deviceId)).toBe('android-a1b2c3');
  });

  it('derives deviceId6 from the first 6 hex chars (hyphens stripped)', () => {
    expect(hostToken('', 'desktop', 'ffeeddccbbaa')).toBe('desktop-ffeedd');
  });

  it('tolerates a missing/short deviceId (trailing separator trimmed)', () => {
    expect(hostToken('', 'desktop', '')).toBe('desktop');
  });
});
