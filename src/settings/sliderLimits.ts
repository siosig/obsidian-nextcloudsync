// Single source of truth for the settings-tab numeric slider bounds (min/max/step).
//
// These control ONLY the choices a slider offers — not the meaning, type, default,
// or sync behaviour of the underlying setting. Coarser steps and tighter bounds
// shrink the reachable value space (project design rule: minimise user freedom,
// keep the remaining state space exhaustively testable). The mockup
// (specs/main/desktop/settings.html) and spec.md §15.1 mirror these exact values.
//
// Invariant: max is a multiple of step for every entry, so the slider never ends
// on a fractional final step. Defaults that fall off the grid (networkConcurrency
// derived from RAM, mobile maxFileSizeMB=20) are preserved non-destructively and
// only snap to the nearest step when the user moves the slider.

export interface SliderLimit {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export const SLIDER_LIMITS = {
  startupSyncDelay: { min: 0, max: 15, step: 1 },
  networkTimeout: { min: 15, max: 120, step: 15 },
  networkConcurrency: { min: 1, max: 64, step: 4 },
  maxFileSize: { min: 0, max: 2048, step: 16 },
} as const satisfies Record<string, SliderLimit>;

export type SliderLimitKey = keyof typeof SLIDER_LIMITS;
