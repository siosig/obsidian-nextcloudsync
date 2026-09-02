// [SPEC:RSY-1] Coming back to the app syncs, on a real Android device (feature 079, discussion #44).
//
// Why this cannot live in another layer: on mobile this trigger is the ONLY one that fires once the
// app has been left running. Periodic sync and watch mode are both switched off there because Android
// suspends background timers — which is also why a desktop test proves nothing here. The a-layer
// tests cover the decision with injected seams; what they cannot cover is whether Android actually
// delivers the foreground signal to Obsidian's WebView, which is the entire premise.
//
// The 5-minute cooldown is real and would make an honest test wait five minutes, so the recorded
// last-sync time is pushed into the past first. That is the same value production reads; nothing
// about the trigger itself is stubbed.
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
    // Narrower than the AND-1 probe next door: that one checks the platform emits the event at all,
    // this one checks the plugin's own subscription survived to receive it. A listener registered in
    // onLayoutReady and then torn down by something would fail here and nowhere else.
    await browser.executeObsidian(() => {
      (window as unknown as Record<string, unknown>).__b3ResumeSync = 0;
      const bump = (): void => {
        const w = window as unknown as Record<string, number>;
        w.__b3ResumeSync += 1;
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') bump();
      });
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

    // Bring the engine up and put the recorded last-sync time well outside the cooldown, so the
    // resume has something to do. Six minutes against a five-minute window.
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

    // A sync stamps the last-sync time in its finally block, whatever started it. The stamp moving
    // forward is therefore the evidence that a sync actually ran — not that an event was received.
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
    // The half that decides whether this feature is welcome. On a phone, stepping out to another app
    // and back is a normal thing to do several times a minute; a sync each time would be paid for in
    // data and battery. The previous scenario has just synced, so the clock is fresh.
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
