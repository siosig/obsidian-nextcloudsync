import { formatClock24 } from '../../src/ui/timeFormat';

// Build local-time timestamps so the assertions are timezone-independent.
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

describe('formatClock24 (US3 24-hour absolute time)', () => {
  const now = at(2026, 6, 20, 12, 0);

  it('formats a same-day time as zero-padded HH:mm', () => {
    expect(formatClock24(at(2026, 6, 20, 9, 5), now)).toBe('09:05');
    expect(formatClock24(at(2026, 6, 20, 14, 30), now)).toBe('14:30');
  });

  it('prefixes the date (MM-DD) when not the same calendar day', () => {
    expect(formatClock24(at(2026, 6, 19, 23, 50), now)).toBe('06-19 23:50');
  });

  it('handles the midnight boundary within the 24h window', () => {
    const today0010 = formatClock24(at(2026, 6, 20, 0, 10), now);
    const yest2355 = formatClock24(at(2026, 6, 19, 23, 55), now);
    expect(today0010).toBe('00:10');          // same day → no date prefix
    expect(yest2355).toBe('06-19 23:55');      // previous day → date prefix
  });

  it('never emits AM/PM or relative text', () => {
    const s = formatClock24(at(2026, 6, 20, 13, 0), now);
    expect(s).not.toMatch(/AM|PM|ago/i);
  });
});
