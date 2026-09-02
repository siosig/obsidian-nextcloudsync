/**
 * Syncing when the app comes back to the foreground (feature 079, GitHub discussion #44).
 *
 * Mobile has neither periodic sync nor watch mode — both are switched off there because the OS
 * suspends background timers, so neither can be relied on. That leaves an Obsidian left running in
 * the background with no way to notice that another device changed a note: nothing happens until the
 * user syncs by hand or restarts the app.
 *
 * Coming back to the foreground is the one moment when the app is provably running and the user is
 * provably looking at it, which makes it the only trigger that does not depend on background
 * execution working. It is registered on every platform rather than only on mobile: a desktop machine
 * that slept has the same hole (its interval timer did not tick while it was asleep), and not
 * branching on the platform is the simpler shape.
 *
 * The risk is entirely in the other direction — a trigger that fires on every app switch would spend
 * the user's data and battery for nothing — so the cooldown below is the part that matters.
 */

/**
 * Minimum gap between syncs for this trigger to fire.
 *
 * Not a setting, and deliberately so. Five minutes is short enough that any real "I was away and came
 * back" case syncs (the complaint in #44 was hours in the background) and long enough that the normal
 * mobile rhythm of glancing at a notification and returning costs nothing. For scale: the desktop
 * sync interval defaults to 15 minutes, so this is the more responsive of the two, not the less.
 */
export const RESUME_SYNC_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Subscribe to "the app came back to the foreground"; returns the unsubscribe function.
 *
 * Extracted from `LoginFlowV2`, which has used exactly this since issue #34 and is covered by a
 * real-device b-3 test. Both events are kept: `visibilitychange` is what fires on mobile when the app
 * returns, and `focus` is what fires on desktop. Narrowing that here would change behaviour already
 * verified on a device, to no benefit — the cooldown absorbs the extra desktop firings.
 *
 * Guarded because the a-layer suite runs under jest's `node` environment, where neither global
 * exists. Keeping the guard here is what lets every call site stay free of environment checks.
 */
export function onAppResume(cb: () => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined;
  const onVisibility = (): void => { if (document.visibilityState === 'visible') cb(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', cb);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', cb);
  };
}

/**
 * Whether a resume at `now` should sync, given when the last sync finished.
 *
 * `lastSyncTime` is the timestamp every sync stamps in its finally block, whatever started it —
 * startup, interval, manual, or this trigger. Using the shared value rather than tracking resumes
 * separately is what makes "do not sync twice when the app has only just started" fall out for free:
 * the startup sync has already moved the clock forward by the time the resume event arrives.
 *
 * A never-synced vault (`0`) counts as long ago, so the first resume after installing does something.
 * A timestamp in the future — a clock change, or state written by a device running ahead — counts as
 * recent, so a bad clock cannot turn every resume into a sync. Declining is the safe direction: the
 * manual and periodic paths still work.
 */
export function shouldSyncOnResume(now: number, lastSyncTime: number, cooldownMs: number): boolean {
  const elapsed = now - lastSyncTime;
  if (elapsed < 0) return false;
  return elapsed >= cooldownMs;
}

/** What {@link makeResumeSyncHandler} needs from its host, kept narrow so tests need no plugin. */
export interface ResumeSyncDeps {
  /** The sync engine, or null/undefined while the settings are incomplete or it is still starting. */
  getEngine: () => { syncManual: () => Promise<void> } | null | undefined;
  getLastSyncTime: () => number;
  now?: () => number;
  log: (message: string) => void;
  cooldownMs?: number;
}

/**
 * Build the callback to run on each foreground resume.
 *
 * Separate from `main.ts` on purpose: inline, the two behaviours worth testing — that it syncs, and
 * that it stops syncing — would only be reachable by constructing a whole plugin, which in practice
 * means they would not be tested.
 *
 * Failure is silent by design. The user did not ask for this sync, so an engine that is not up yet is
 * a no-op rather than an error, and nothing here interrupts them with a notice. Both outcomes are
 * logged so the behaviour can still be explained afterwards from the diagnostic log.
 */
export function makeResumeSyncHandler(deps: ResumeSyncDeps): () => void {
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = deps.cooldownMs ?? RESUME_SYNC_COOLDOWN_MS;
  return () => {
    const engine = deps.getEngine();
    if (!engine) return;
    if (!shouldSyncOnResume(now(), deps.getLastSyncTime(), cooldownMs)) {
      deps.log('resume: skipped — synced within the cooldown');
      return;
    }
    deps.log('resume: app returned to the foreground — syncing');
    void engine.syncManual();
  };
}
