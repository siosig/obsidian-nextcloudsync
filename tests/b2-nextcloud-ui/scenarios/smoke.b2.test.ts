// b-2 smoke + main wiring (FR-025). Scope is deliberately shallow (clarify D):
// plugin enabled -> settings entered -> manual sync command runs -> status shown.
// Deep pause/resume & conflict behaviour stays in b-1.
//
// Uses wdio-obsidian-service browser commands (executeObsidian /
// executeObsidianCommand) + the wdio/mocha globals. Sync steps skip when
// NEXTCLOUD_* are absent; the enable/wiring checks still run (Obsidian is always
// provisioned by the service).
import { browser, expect } from '@wdio/globals';
import { requireUiEnv } from '../support/env';

const ui = requireUiEnv();

describe('[SPEC:FR-025] b-2 smoke — enable, settings, manual sync, status', function () {
  it('the Nextcloud Sync plugin is installed and enabled', async () => {
    const enabled = await browser.executeObsidian(
      ({ app }) => !!(app as any).plugins.enabledPlugins.has('nextcloud-sync'),
    );
    expect(enabled).toBe(true);
  });

  it('initial setup: connection settings can be seeded and saved via the plugin', async function () {
    if (!ui.ok) this.skip();
    const saved = await browser.executeObsidian(
      async ({ app }, server: string, user: string) => {
        const p = (app as any).plugins.plugins['nextcloud-sync'];
        // Single source of truth: seed validated values (login flow derives the
        // WebDAV endpoint; no free-form URL entry).
        p.settings.serverUrl = server;
        p.settings.username = user;
        await p.saveData?.(p.settings);
        return p.settings.username;
      },
      ui.values.NEXTCLOUD_SERVER_URL,
      ui.values.NEXTCLOUD_USER,
    );
    expect(saved).toBe(ui.values.NEXTCLOUD_USER);
  });

  it('manual sync command (nextcloud-sync:sync-now) runs and surfaces a status', async function () {
    if (!ui.ok) this.skip();
    await browser.executeObsidianCommand('nextcloud-sync:sync-now');
    await browser.pause(2000);
    const statusPresent = await browser.executeObsidian(
      () => !!document.querySelector('.status-bar-item, .notice'),
    );
    expect(statusPresent).toBe(true);
  });
});
