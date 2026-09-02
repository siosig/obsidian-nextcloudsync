// [SPEC:RSY-1] [SPEC:RSY-2] The decision taken on every foreground resume (feature 079).
//
// The handler is deliberately separate from main.ts. Wiring it inline would have left the two things
// that matter — "does it sync?" and "does it stop syncing?" — reachable only by standing up a whole
// plugin instance, which is why they would then not have been tested at all.
import { makeResumeSyncHandler, RESUME_SYNC_COOLDOWN_MS } from '../../../src/util/appResume';

const COOLDOWN = 5 * 60 * 1000;

function build(opts: { engine?: boolean; lastSync?: number } = {}) {
  const syncManual = jest.fn(async () => undefined);
  const logs: string[] = [];
  let now = 100_000_000;
  const handler = makeResumeSyncHandler({
    getEngine: () => (opts.engine === false ? null : { syncManual }),
    getLastSyncTime: () => opts.lastSync ?? 0,
    now: () => now,
    log: (m: string) => { logs.push(m); },
    cooldownMs: COOLDOWN,
  });
  return { handler, syncManual, logs, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe('[SPEC:RSY-1] a resume triggers one incremental sync', () => {
  it('syncs when the cooldown has elapsed', () => {
    const h = build({ lastSync: 0 });
    h.handler();
    expect(h.syncManual).toHaveBeenCalledTimes(1);
  });

  it('reuses the existing sync rather than inventing a resume-specific one', () => {
    // syncManual already carries the running-guard, the Wi-Fi-only check, and the feature-078
    // protections (per-path serialization, holding remote writes back while a file is being edited).
    // Calling anything else here would mean re-earning all of that.
    const h = build({ lastSync: 0 });
    h.handler();
    expect(h.syncManual).toHaveBeenCalledWith();
  });

  it('says in the log what it did', () => {
    const h = build({ lastSync: 0 });
    h.handler();
    expect(h.logs.join('\n')).toMatch(/resume/i);
  });
});

describe('[SPEC:RSY-2] repeated resumes must not turn into repeated syncs', () => {
  it('syncs once, then stays quiet for the whole cooldown', () => {
    // The realistic failure this guards: glance at a notification, come back, glance again. On mobile
    // that is a normal minute of use, and a sync per switch would be paid for in data and battery.
    const h = build({ lastSync: 0 });
    h.handler();
    expect(h.syncManual).toHaveBeenCalledTimes(1);

    // The sync just ran, so the recorded time moves with it — as it does in production, where every
    // sync stamps it in its finally block.
    const after = build({ lastSync: h.at() });
    for (let i = 0; i < 10; i++) after.handler();
    expect(after.syncManual).not.toHaveBeenCalled();
  });

  it('syncs again once the cooldown has passed', () => {
    const h = build({ lastSync: 100_000_000 - COOLDOWN - 1 });
    h.handler();
    expect(h.syncManual).toHaveBeenCalledTimes(1);
  });

  it('records why it declined, so the behaviour can be explained from a log', () => {
    const h = build({ lastSync: 100_000_000 });
    h.handler();
    expect(h.syncManual).not.toHaveBeenCalled();
    expect(h.logs.join('\n')).toMatch(/cooldown/i);
  });
});

describe('[SPEC:RSY-2] the shipped cooldown, not just the one a test passes in', () => {
  // Found by mutation: every test above supplied its own cooldown, so setting the exported constant
  // to 0 left the whole suite green while the shipped build synced on every app switch — the one
  // failure this feature can actually inflict on someone. Pinning the default closes that.

  it('applies the exported default when no cooldown is given', () => {
    const syncManual = jest.fn(async () => undefined);
    const now = 100_000_000;
    const handler = makeResumeSyncHandler({
      getEngine: () => ({ syncManual }),
      getLastSyncTime: () => now - 1, // a sync a millisecond ago
      now: () => now,
      log: () => undefined,
    });
    handler();
    expect(syncManual).not.toHaveBeenCalled();
  });

  it('keeps the default long enough that ordinary app switching costs nothing', () => {
    // A lower bound with a reason rather than an exact value: the point is that glancing at another
    // app and coming back must not sync, and a minute is the shortest gap for which that holds. The
    // upper bound guards the opposite mistake — a cooldown longer than the desktop sync interval
    // would make the trigger pointless, since the periodic sync would beat it to every case.
    expect(RESUME_SYNC_COOLDOWN_MS).toBeGreaterThanOrEqual(60_000);
    expect(RESUME_SYNC_COOLDOWN_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});

describe('[SPEC:RSY-3] a resume with nothing to sync is a no-op, not an error', () => {
  it('does nothing when the sync engine is not initialized', () => {
    // Reaching this state is ordinary: the server settings are incomplete, or the user resumed
    // during startup before the engine finished coming up. The user did not ask for a sync here, so
    // there is nothing to report and nothing to interrupt them with.
    const h = build({ engine: false, lastSync: 0 });
    expect(() => h.handler()).not.toThrow();
    expect(h.syncManual).not.toHaveBeenCalled();
  });

  it('does not check the clock before it checks that there is an engine', () => {
    // Ordering matters only in that no path may throw; asserting the outcome covers both orders.
    const h = build({ engine: false, lastSync: 100_000_000 });
    expect(() => h.handler()).not.toThrow();
    expect(h.syncManual).not.toHaveBeenCalled();
  });
});
