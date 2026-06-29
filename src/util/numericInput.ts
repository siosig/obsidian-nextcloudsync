/** Pure helper for the settings-tab editable numeric inputs paired with each slider (spec 036). */

/**
 * Normalize a raw numeric-input string into a valid setting value.
 *
 * - Empty / non-numeric / NaN → return `current` (the last valid value, so a bad keystroke never
 *   corrupts the setting).
 * - Otherwise round to an integer (these settings are seconds/minutes/MB/counts) and clamp to
 *   `[min, max]` (the slider's range — the source of truth shared with the slider).
 *
 * The numeric input accepts any integer in range (1-granularity), unlike the coarse slider step, so
 * off-grid values (e.g. 20 MB, concurrency 3, 25) are reachable by keyboard. See spec 036 SNI-1..4.
 */
export function normalizeNumericInput(raw: string, min: number, max: number, current: number): number {
  if (raw.trim() === '') return current;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) return current;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}
