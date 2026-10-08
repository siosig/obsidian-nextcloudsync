// Single source of truth for the settings-tab slider bounds (min/max/step); docs/spec.md §15.1.1 mirrors these values.
// They limit only the choices a slider offers, not the setting's meaning, type, default or sync behaviour.
// Invariant: max is a multiple of step for every entry, so the slider never ends on a fractional final step. Defaults off
// the grid (syncIntervalMinutes=15, RAM-derived networkConcurrency, mobile maxFileSizeMB=20) are preserved and snap only
// when the user moves the slider.
// startupSyncDelay (0 = no startup sync) and syncInterval (0 = manual sync only) carry a "0 = off" meaning. networkConcurrency
// allows 0 too, but consumers floor it with Math.max(1, …), so 0 means "effectively 1" (kept for a clean 0/4/8/…/60 grid).

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
