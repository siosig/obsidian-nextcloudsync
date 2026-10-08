// [SPEC:MWM-4] Watch mode runs on a real Android device: only a real device shows that Obsidian's Android WebView
// delivers vault events and exposes navigator.connection.type.
// "Sync now" is never pressed, so a note reaches the server only via the plugin's vault-event listeners;
// "Wi-Fi only" is off so the result does not depend on the device's network.
import { browser, expect } from '@wdio/globals';
import type { TFile } from 'obsidian';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';
import { seedConnection } from '../support/plugin';
import { RemoteProbe } from '../support/webdav';

describe('[SPEC:MWM-4] b-3 — watch mode on a real Android device', function () {
  let probe: RemoteProbe | undefined;
  let path = '';

  before(async function () {
    requireEnvOrSkip(this);
  });

  after(async function () {
    if (probe && path) await probe.removeQuietly(path);
  });

  it('exposes navigator.connection.type in the WebView', async function () {
    const t = await browser.executeObsidian(
      () => (navigator as unknown as { connection?: { type?: string } }).connection?.type ?? null,
    );
    expect(['bluetooth', 'cellular', 'ethernet', 'none', 'mixed', 'other', 'unknown', 'wifi', 'wimax']).toContain(t);
  });

  it('pushes a new note to the server without "Sync now"', async function () {
    const v = requireAndroidEnv().values;
    await seedConnection(v.NEXTCLOUD_SERVER_URL, v.NEXTCLOUD_USER, v.NEXTCLOUD_PASSWORD);

    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as never as { plugins: { plugins: Record<string, {
        settings: { watchOnChangeEnabled: boolean; syncOnWifiOnly: boolean };
        saveSettings?: () => Promise<void>;
      }> } }).plugins.plugins['nextcloud-sync'];
      plugin.settings.watchOnChangeEnabled = true;
      plugin.settings.syncOnWifiOnly = false;
      await plugin.saveSettings?.();
    });

    probe = await RemoteProbe.forCurrentVault();
    path = `mwm4-${Date.now()}.md`;
    const body = 'created by MWM-4';
    const remote = probe;

    await browser.executeObsidian(async ({ app }, p: string, b: string) => {
      await app.vault.create(p, b);
    }, path, body);

    await browser.waitUntil(
      async () => {
        const r = await remote.get(path);
        return r.status === 200 && r.body.toString('utf-8') === body;
      },
      { timeout: 60_000, interval: 2_000, timeoutMsg: 'the new note never reached the server through watch mode' },
    );
  });

  it('pushes an edit to the server without "Sync now"', async function () {
    if (!probe || !path) throw new Error('the create scenario did not run, so there is no note to edit');
    const remote = probe;
    const b2 = 'edited by MWM-4';

    await browser.executeObsidian(async ({ app }, p: string, b: string) => {
      await app.vault.modify(app.vault.getAbstractFileByPath(p) as TFile, b);
    }, path, b2);

    await browser.waitUntil(
      async () => {
        const r = await remote.get(path);
        return r.status === 200 && r.body.toString('utf-8') === b2;
      },
      { timeout: 60_000, interval: 2_000, timeoutMsg: 'the edit never reached the server through watch mode' },
    );
  });
});
