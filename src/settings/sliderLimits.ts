// Single source of truth for the settings-tab numeric slider bounds (min/max/step).
//
// These control ONLY the choices a slider offers — not the meaning, type, default,
// or sync behaviour of the underlying setting. Coarser steps and tighter bounds
// shrink the reachable value space (project design rule: minimise user freedom,
// keep the remaining state space exhaustively testable). The mockup
// (specs/main/desktop/settings.html) and spec.md §15.1 mirror these exact values.
//
// Invariant: max is a multiple of step for every entry, so the slider never ends
// on a fractional final step. Defaults that fall off the grid (syncIntervalMinutes=15,
// RAM-derived networkConcurrency values, mobile maxFileSizeMB=20) are preserved
// non-destructively and only snap to the nearest step when the user moves the slider.
//
// Two sliders carry a "0 = off" semantic on top of the limit: startupSyncDelay (0 =
// no startup sync — folds the former "Sync on startup" toggle) and syncInterval
// (0 = manual sync only). networkConcurrency exposes 0 too, but its consumers floor
// it with Math.max(1, …), so 0 means "effectively 1" (kept for a clean 0/4/8/…/60 grid).

export interface SliderLimit {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export const SLIDER_LIMITS = {
  startupSyncDelay: { min: 0, max: 10, step: 1 },
  syncInterval: { min: 0, max: 60, step: 4 },
  networkTimeout: { min: 15, max: 120, step: 15 },
  networkConcurrency: { min: 0, max: 60, step: 4 },
  maxFileSize: { min: 0, max: 2048, step: 16 },
} as const satisfies Record<string, SliderLimit>;

export type SliderLimitKey = keyof typeof SLIDER_LIMITS;
