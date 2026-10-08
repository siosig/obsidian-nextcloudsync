// [SPEC:RSY-1] Coming back to the app syncs, on a real Android device (discussion #44).
// On mobile this is the only trigger that fires while the app stays open (periodic sync and watch mode are off
// because Android suspends background timers). Only a real device shows that Android delivers the foreground
// signal to Obsidian's WebView. The 5-minute cooldown is bypassed by pushing the recorded last-sync time into the past.
import { browser, expect } from '@wdio/globals';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';
import { seedConnection } from '../support/plugin';
import { suspend } from '../support/android';

const env = requireAndroidEnv();

describe('[SPEC:RSY-1] b-3 — returning to the app runs a sync', function () {
  before(async function () {
    requireEnvOrSkip(this);
  });

  it('delivers a foreground-resume signal that the plugin is listening for', async function () {
    // Narrower than the AND-1 probe: this checks the plugin's own subscription still receives a resume.
    // Subscribe to both events, as onAppResume does (src/util/appResume.ts); a resume can arrive as `focus` instead of visibilitychange.
    await browser.executeObsidian(() => {
      (window as unknown as Record<string, unknown>).__b3ResumeSync = 0;
      const bump = (): void => {
        const w = window as unknown as Record<string, number>;
        w.__b3ResumeSync += 1;
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') bump();
      });
      window.addEventListener('focus', bump);
    });

    await suspend();

    const count = await browser.executeObsidian(
      () => (window as unknown as Record<string, number>).__b3ResumeSync,
    );
    expect(count).toBeGreaterThan(0);
  });

  it('syncs on return when the last sync is older than the cooldown', async function () {
    const v = env.values;
    await seedConnection(v.NEXTCLOUD_SERVER_URL, v.NEXTCLOUD_USER, v.NEXTCLOUD_PASSWORD);

    // Put the recorded last-sync time six minutes back, outside the five-minute cooldown.
    const before = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as never as { plugins: { plugins: Record<string, {
        initSyncEngine?: () => Promise<unknown>;
        syncEngine?: { getLastSyncTime(): number };
      }> } }).plugins.plugins['nextcloud-sync'];
      await plugin.initSyncEngine?.();
      const engine = plugin.syncEngine as unknown as {
        opts: { stateDB: { setLastSyncTime(t: number): void; getLastSyncTime(): number } };
      };
      const stale = Date.now() - 6 * 60 * 1000;
      engine.opts.stateDB.setLastSyncTime(stale);
      return engine.opts.stateDB.getLastSyncTime();
    });
    expect(before).toBeGreaterThan(0);

    await suspend();

    // A sync stamps the last-sync time in its finally block, so the stamp moving forward is the evidence a sync ran.
    const advanced = await browser.waitUntil(
      async () => {
        const now = await browser.executeObsidian(({ app }) => {
          const plugin = (app as never as { plugins: { plugins: Record<string, {
            syncEngine?: { getLastSyncTime(): number };
          }> } }).plugins.plugins['nextcloud-sync'];
          return plugin.syncEngine?.getLastSyncTime() ?? 0;
        });
        return now > before;
      },
      { timeout: 60_000, interval: 2_000, timeoutMsg: 'no sync ran after returning to the app' },
    );
    expect(advanced).toBe(true);
  });

  it('does not sync again on a second return inside the cooldown', async function () {
    // Stepping out to another app and back is frequent on a phone; a sync each time would cost data and battery.
    const before = await browser.executeObsidian(({ app }) => {
      const plugin = (app as never as { plugins: { plugins: Record<string, {
        syncEngine?: { getLastSyncTime(): number };
      }> } }).plugins.plugins['nextcloud-sync'];
      return plugin.syncEngine?.getLastSyncTime() ?? 0;
    });
    expect(before).toBeGreaterThan(0);

    await suspend();
    await browser.pause(5_000); // give a sync every chance to start and stamp the clock

    const after = await browser.executeObsidian(({ app }) => {
      const plugin = (app as never as { plugins: { plugins: Record<string, {
        syncEngine?: { getLastSyncTime(): number };
      }> } }).plugins.plugins['nextcloud-sync'];
      return plugin.syncEngine?.getLastSyncTime() ?? 0;
    });
    expect(after).toBe(before);
  });
});
