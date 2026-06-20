// Pure time formatting for the Sync Status dialog, separated from the view so it is unit-testable
// without a DOM. 24-hour absolute clock (no AM/PM, no relative "ago"), with a date prefix when the
// timestamp is not on the same calendar day as `now` (the 24h window can cross midnight).

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Format an epoch-ms timestamp as a 24-hour absolute local time.
 *   - same calendar day as `now` → `HH:mm`            (e.g. `09:05`, `14:30`)
 *   - a different day            → `MM-DD HH:mm`       (e.g. `06-19 23:50`)
 * Local timezone; deterministic given (at, now).
 */
export function formatClock24(at: number, now: number): string {
  const d = new Date(at);
  const ref = new Date(now);
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate();
  return sameDay ? hhmm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm}`;
}
