// [SPEC:AND-1] Browser sign-in must complete after the app has been backgrounded (issue #34).
// Android suspends the WebView's timers while the browser is in front, so the poll loop must race its timer
// against a foreground-resume signal (`visibilitychange` / `focus`). Desktop keeps timers running, so only a
// real device reproduces this. Approval is automated server-side (support/loginFlow.ts).
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
    // If the platform does not emit visibilitychange/focus on return, the end-to-end case below cannot work.
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

    await browser.executeObsidian(async ({ app }) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      p.settings.passwordSecretId = '';
      p.settings.username = '';
      await p.saveData?.(p.settings);
    });

    // Start the real flow via the settings tab entry point; window.open is stubbed because approval happens from the test process.
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
        // Plugin tabs are in `pluginTabs`, core ones in `settingTabs`; search both and match the manifest id too.
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
        // Call the tab's own handler (`runLoginFlow` is private in TypeScript only).
        void tab.runLoginFlow();
        // Wait for the handler to reach window.open, which carries the login URL.
        for (let i = 0; i < 60 && !w.__b3Opened; i++) await new Promise((r) => setTimeout(r, 500));
        return w.__b3Opened as string | null;
      } finally {
        w.open = realOpen;
      }
    }, base);

    expect(loginUrl).toBeTruthy();

    // Background the app first, then approve, as a real user would; without the fix the poll loop stays parked.
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
