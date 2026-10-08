// Pure time formatting for the Sync Status dialog. The 24h window can cross midnight, so a date prefix is added
// when the timestamp is not on the same calendar day as `now`.

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Same day as `now`: HH:mm (09:05); otherwise MM-DD HH:mm (06-19 23:50). Local timezone.
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
