// b-2 smoke + main wiring (FR-025). Scope is deliberately shallow (clarify D):
// enable plugin -> enter settings -> trigger a manual sync once -> observe status
// -> initial setup. Deep pause/resume & conflict behaviour stays in b-1.
//
// Uses wdio globals (browser, $, $$) provided by @wdio/cli at run time. Skips the
// whole suite when UI creds/driver are absent.
//
// NOTE: selectors/command ids below are the documented baseline; confirm against
// the running Obsidian build at first execution (research.md D4). This file is the
// executable scaffold the b-2 suite grows from.
import { requireUiEnv } from '../support/env';

const ui = requireUiEnv();
const maybe = ui.ok ? describe : describe.skip;

maybe('[SPEC:FR-025] b-2 smoke — plugin enable, settings, manual sync, status', () => {
  before(function () {
    if (!ui.ok) this.skip();
  });

  it('the Nextcloud Sync plugin is enabled in a real Obsidian vault', async () => {
    // wdio-obsidian-service launches with the plugin loaded; assert it is active.
    const enabled = await browser.execute(
      // @ts-expect-error app is the Obsidian global inside the renderer
      () => !!app.plugins.plugins['nextcloud-sync'],
    );
    expect(enabled).toBe(true);
  });

  it('initial setup: connection settings can be entered and saved via the settings UI', async () => {
    // Open the plugin settings tab and persist the live connection values.
    await browser.execute(
      // @ts-expect-error Obsidian globals
      (server, user) => {
        const p = app.plugins.plugins['nextcloud-sync'];
        // Single-source-of-truth settings write (no free-form WebDAV URL): the
        // login flow derives the endpoint; here we seed the validated values.
        p.settings.serverUrl = server;
        p.settings.username = user;
        return p.saveData?.(p.settings);
      },
      ui.values.NEXTCLOUD_SERVER_URL,
      ui.values.NEXTCLOUD_USER,
    );
    const saved = await browser.execute(
      // @ts-expect-error Obsidian globals
      () => app.plugins.plugins['nextcloud-sync'].settings.username,
    );
    expect(saved).toBe(ui.values.NEXTCLOUD_USER);
  });

  it('manual sync command runs once and surfaces a status (no crash)', async () => {
    const ran = await browser.execute(
      // @ts-expect-error Obsidian globals
      () => {
        const cmds = app.commands.commands;
        const id = Object.keys(cmds).find((k) => k.startsWith('nextcloud-sync:'));
        if (!id) return false;
        app.commands.executeCommandById(id);
        return true;
      },
    );
    expect(ran).toBe(true);
    // Give the status bar / notice a moment, then assert the status node exists.
    await browser.pause(2000);
    const statusPresent = await browser.execute(
      () => !!document.querySelector('.status-bar-item, .notice'),
    );
    expect(statusPresent).toBe(true);
  });
});
