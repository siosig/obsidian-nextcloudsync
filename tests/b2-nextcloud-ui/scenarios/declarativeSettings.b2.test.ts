// [SPEC:DSD-6] [SPEC:DSD-7] [SPEC:DSD-8] The declarative settings tab, rendered by the real Obsidian.
// Layer a drives a plain fake with no DOM, so a valid definition array can still render a blank screen.
import { browser, expect } from '@wdio/globals';
import { requireUiEnv } from '../support/env';

const ui = requireUiEnv();

// Probed on Obsidian 1.13.7: plugin tabs live in `app.setting.pluginTabs` (`settingTabs` is undefined), and the
// settings modal can render into a popout window, so every query goes through the tab's containerEl, not document.

const readRenderedRows = () =>
  browser.executeObsidian(async ({ app }) => {
    const setting = (app as any).setting;
    await setting.open();
    setting.openTabById('nextcloud-sync');
    await new Promise((r) => setTimeout(r, 600));
    const tab = setting.pluginTabs.find((t: any) => t.id === 'nextcloud-sync');
    const el = tab?.containerEl as HTMLElement | undefined;
    return {
      rows: el?.querySelectorAll('.setting-item').length ?? -1,
      names: Array.from(el?.querySelectorAll('.setting-item-name') ?? []).map((e) => e.textContent ?? ''),
      text: el?.textContent ?? '',
    };
  }) as Promise<{ rows: number; names: string[]; text: string }>;

const closeSettings = () =>
  browser.executeObsidian(({ app }) => { (app as any).setting.close(); });


describe('[SPEC:DSD-6] b-2 — the settings tab renders from the definitions', function () {
  it('renders rows at all (an empty definition array would render nothing)', async function () {
    if (!ui.ok) this.skip();
    // An empty getSettingDefinitions() would render a blank tab with no fallback.
    const { rows, names } = await readRenderedRows();
    expect(rows).toBeGreaterThan(30);

    expect(names).toContain('Server URL');
    expect(names).toContain('Last session summary');
    await closeSettings();
  });

  it('shows the not-signed-in banner only while signed out', async function () {
    if (!ui.ok) this.skip();
    await browser.executeObsidian(async ({ app }) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      p.settings.username = '';
      await p.saveData?.(p.settings);
    });
    const { text } = await readRenderedRows();
    // renderNotice writes the copy directly, so match the banner body text, not a .setting-item-name.
    expect(text).toContain('Syncing stays disabled until you do');
    await closeSettings();
  });
});

describe('[SPEC:DSD-7] b-2 — dynamic rows are rebuilt, not cached', function () {
  it('adds a row when a folder is excluded and removes it again', async function () {
    if (!ui.ok) this.skip();
    const result = await browser.executeObsidian(async ({ app }) => {
      const setting = (app as any).setting;
      await setting.open();
      setting.openTabById('nextcloud-sync');
      await new Promise((r) => setTimeout(r, 600));
      const tab = setting.pluginTabs.find((t: any) => t.id === 'nextcloud-sync');
      const names = () =>
        Array.from((tab.containerEl as HTMLElement).querySelectorAll('.setting-item-name'))
          .map((e) => e.textContent ?? '');

      // Use the same calls as the Add and trash buttons so update() rebuilds the definition array.
      const before = names().length;
      await tab.addExcludedFolder('b2-excluded-probe');
      await new Promise((r) => setTimeout(r, 400));
      const withFolder = names();
      await tab.removeExcludedFolder('b2-excluded-probe');
      await new Promise((r) => setTimeout(r, 400));
      const after = names().length;

      setting.close();
      return {
        before,
        withFolder: withFolder.length,
        after,
        listed: withFolder.includes('b2-excluded-probe'),
        excludedAfter: (app as any).plugins.plugins['nextcloud-sync'].settings.excludedFolders.length,
      };
    });

    // A tab that reused its first definition array would report the same names all three times.
    expect(result.listed).toBe(true);
    expect(result.withFolder).toBe(result.before + 1);
    expect(result.after).toBe(result.before);
    expect(result.excludedAfter).toBe(0);
  });
});

describe('[SPEC:DSD-8] b-2 — the key-path binding reaches storage', function () {
  it('persists a value changed through the declarative binding across a plugin reload', async function () {
    if (!ui.ok) this.skip();
    const roundTrip = await browser.executeObsidian(async ({ app }) => {
      const plugins = (app as any).plugins;
      const tab = (app as any).setting.pluginTabs.find((t: any) => t.id === 'nextcloud-sync');

      // A dotted key covers the nested case, where a naive setter would write an unread top-level property.
      await tab.setControlValue('massDeleteLimit', 4242);
      await tab.setControlValue('configSync.bookmarks', false);

      await plugins.disablePlugin('nextcloud-sync');
      await plugins.enablePlugin('nextcloud-sync');
      const reloaded = plugins.plugins['nextcloud-sync'];
      const out = {
        massDeleteLimit: reloaded.settings.massDeleteLimit,
        bookmarks: reloaded.settings.configSync?.bookmarks,
        readBack: (app as any).setting.pluginTabs
          .find((t: any) => t.id === 'nextcloud-sync')
          ?.getControlValue('configSync.bookmarks'),
      };
      reloaded.settings.massDeleteLimit = -1;
      reloaded.settings.configSync.bookmarks = true;
      await reloaded.saveData?.(reloaded.settings);
      return out;
    });

    expect(roundTrip.massDeleteLimit).toBe(4242);
    expect(roundTrip.bookmarks).toBe(false);
    expect(roundTrip.readBack).toBe(false);
  });
});
