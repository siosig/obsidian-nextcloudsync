// Invalid input returns `current` so a bad keystroke never corrupts the setting. Valid input is
// rounded to an integer and clamped to the slider's range. Unlike the coarse slider step, any integer
// is accepted, so off-grid values (e.g. 20 MB, concurrency 3) are reachable by keyboard.
export function normalizeNumericInput(raw: string, min: number, max: number, current: number): number {
  if (raw.trim() === '') return current;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) return current;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}
