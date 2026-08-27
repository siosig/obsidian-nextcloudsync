// [SPEC:AND-1] Browser sign-in must complete after the app has been backgrounded (issue #34).
//
// Regression origin: approving in the browser puts Obsidian in the background, where Android suspends
// the WebView's timers. The poll loop was parked on a `setTimeout` that never fired, so the app
// password waiting on the server was never collected and sign-in silently stalled. The fix races the
// timer against a foreground-resume signal (`visibilitychange` / `focus`).
//
// Why this cannot live in another layer: the failure IS the OS suspending timers. On desktop an
// unfocused Electron window keeps running them, so the bug cannot appear. Layer a covers the loop's
// logic with injected seams, which is exactly the kind of coverage that passed while the real device
// stayed broken — the seam under test was the one thing the real platform did differently.
//
// Approval is automated server-side (support/loginFlow.ts) so no human has to tap "Grant access".
import { browser, expect } from '@wdio/globals';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';
import { seedConnection } from '../support/plugin';
import { suspend } from '../support/android';
import { approveLoginFlow, serverBaseFromDavUrl } from '../support/loginFlow';

const env = requireAndroidEnv();

describe('[SPEC:AND-1] b-3 — sign-in completes after a background/foreground cycle', function () {
  before(async function () {
    requireEnvOrSkip(this);
  });

  it('delivers a foreground-resume signal to the webview', async function () {
    // The fix depends on the platform emitting visibilitychange/focus on return. If this fails, the
    // end-to-end case below cannot possibly work and the cause is the platform, not the plugin.
    await browser.executeObsidian(() => {
      (window as any).__b3Resume = 0;
      const bump = (): void => {
        (window as any).__b3Resume += 1;
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') bump();
      });
      window.addEventListener('focus', bump);
    });

    await suspend();

    const count = await browser.executeObsidian(() => (window as any).__b3Resume as number);
    expect(count).toBeGreaterThan(0);
  });

  it('collects the app password approved while the app was in the background', async function () {
    const base = serverBaseFromDavUrl(env.values.NEXTCLOUD_SERVER_URL);

    // Clear any stored credential so the assertion cannot pass on a leftover.
    await browser.executeObsidian(async ({ app }) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      p.settings.passwordSecretId = '';
      p.settings.username = '';
      await p.saveData?.(p.settings);
    });

    // Kick off the real flow from inside the app, the same entry point the settings tab uses.
    // window.open is stubbed out: on a device it would hand the flow to a real browser, and the
    // approval is performed from the test process instead.
    const loginUrl = await browser.executeObsidian(async ({ app }, serverBase: string) => {
      const w = window as any;
      w.__b3Opened = null;
      const realOpen = w.open;
      w.open = (url: string) => {
        w.__b3Opened = url;
        return null;
      };
      try {
        const p = (app as any).plugins.plugins['nextcloud-sync'];
        p.settings.serverUrl = serverBase;
        await p.saveData?.(p.settings);
        app.setting.open();
        app.setting.openTabById('nextcloud-sync');
        // Obsidian keeps PLUGIN tabs in `pluginTabs`; `settingTabs` holds the core ones. Search both,
        // and match on the manifest id as well, so this does not depend on which list a given
        // Obsidian version files the tab under.
        const setting = app.setting as any;
        const candidates = [...(setting.pluginTabs ?? []), ...(setting.settingTabs ?? [])];
        const tab = candidates.find(
          (t: any) => t?.id === 'nextcloud-sync' || t?.plugin?.manifest?.id === 'nextcloud-sync',
        );
        if (!tab) {
          throw new Error(
            `the plugin settings tab is not registered (saw: ${candidates.map((t: any) => t?.id).join(',')})`,
          );
        }
        // Drive the tab's own handler so the production path runs, not a copy of it. `runLoginFlow`
        // is `private` in TypeScript only — at runtime it is an ordinary method on the instance.
        void tab.runLoginFlow();
        // Wait for the handler to reach window.open, which is where it has the login URL.
        for (let i = 0; i < 60 && !w.__b3Opened; i++) await new Promise((r) => setTimeout(r, 500));
        return w.__b3Opened as string | null;
      } finally {
        w.open = realOpen;
      }
    }, base);

    // wdio's expect takes exactly one argument (no jest-style message parameter).
    expect(loginUrl).toBeTruthy();

    // Background the app FIRST, then approve. This is the real ordering: the user leaves Obsidian,
    // grants access elsewhere, and comes back. With the fix reverted, the poll loop is parked here
    // and never notices the approval.
    await suspend(8_000);
    await approveLoginFlow(
      { baseUrl: base, user: env.values.NEXTCLOUD_USER, password: env.values.NEXTCLOUD_PASSWORD },
      loginUrl as string,
    );
    await suspend(8_000);

    const signedIn = await browser.waitUntil(
      async () => {
        const s = await browser.executeObsidian(({ app }) => {
          const p = (app as any).plugins.plugins['nextcloud-sync'];
          return { username: p.settings.username, secretId: p.settings.passwordSecretId };
        });
        return s.username ? s : false;
      },
      {
        timeout: 120_000,
        interval: 3_000,
        timeoutMsg: 'sign-in never completed after returning to the foreground (issue #34 regression)',
      },
    );
    expect((signedIn as any).username).toBe(env.values.NEXTCLOUD_USER);
    expect((signedIn as any).secretId).toBeTruthy();
  });
});
