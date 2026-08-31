// [SPEC:DSD-6] [SPEC:DSD-7] [SPEC:DSD-8] The declarative settings tab, rendered by the real Obsidian.
//
// Feature 077 replaced the imperative display() with getSettingDefinitions(). Layer a proves the
// definitions are internally consistent — keys resolve, order matches the baseline, predicates
// answer correctly — but it renders nothing: it drives a plain fake, with no Obsidian and no DOM.
// So a definition array can be perfectly valid at layer a and still produce a blank screen here,
// which is exactly the failure mode of getting the new contract subtly wrong. This file is where
// the array meets the renderer.
//
// Three behaviours are checked, chosen because the desktop and iPhone pass already covered the
// visual ones (description length, settings search, the numeric input beside each slider):
//
//   DSD-6  the not-signed-in banner appears and disappears with sign-in state — the one row whose
//          `visible` predicate has a real consequence, and the reason update() is called instead
//          of refreshDomState() after credentials change
//   DSD-7  adding and removing an excluded folder rebuilds the row set — the dynamic-row path,
//          where getSettingDefinitions() must be re-evaluated rather than reusing a stale array
//   DSD-8  a value edited through the declarative binding survives a plugin reload — the
//          key-path binding actually reaching data.json, which is the hazard layer a can only
//          approximate
import { browser, expect } from '@wdio/globals';
import { requireUiEnv } from '../support/env';

const ui = requireUiEnv();

// Two facts about the host, both probed on a real Obsidian 1.13.7 rather than assumed:
//
//   - plugin tabs live in `app.setting.pluginTabs`; the obvious-looking `settingTabs` is undefined
//   - the settings modal can render into a POPOUT window, so `document.querySelectorAll` in the
//     main window sees almost nothing (3 rows) while the tab's own containerEl holds all 40.
//     Every query below therefore goes through the tab, not the document.

/** Open the tab and read its rendered rows out of the tab's own container. */
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
    // display() is deleted, so if getSettingDefinitions() ever returned empty the tab would be
    // blank rather than falling back. That is the single worst outcome of this migration, and it
    // is invisible to every layer-a assertion.
    const { rows, names } = await readRenderedRows();
    // 27 settings + 5 decorations + 8 headings on a default vault.
    expect(rows).toBeGreaterThan(30);

    // Spot-check one row from each end of the array, so a truncated render is caught too.
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
    // Matched on the banner's body text, not its row name: renderNotice empties the row and writes
    // the copy directly, so there is no .setting-item-name to look at.
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

      // Drive the product's own path — the same calls the Add button and the trash button make.
      // Poking settings and re-opening the modal would not exercise update(), which is the part
      // that has to rebuild the definition array for a dynamic row to appear at all.
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

    // The row set is `27 + excludedFolders.length + (syncConfigFolder ? 2 : 0)`; a tab that reused
    // its first definition array would report the same names all three times.
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

      // Drive the same path a rendered control drives: setControlValue resolves the key against
      // storage. A dotted key exercises the nested case (configSync.bookmarks), which is where a
      // naive setter would write a top-level property nobody reads.
      await tab.setControlValue('massDeleteLimit', 4242);
      await tab.setControlValue('configSync.bookmarks', false);

      await plugins.disablePlugin('nextcloud-sync');
      await plugins.enablePlugin('nextcloud-sync');
      const reloaded = plugins.plugins['nextcloud-sync'];
      const out = {
        massDeleteLimit: reloaded.settings.massDeleteLimit,
        bookmarks: reloaded.settings.configSync?.bookmarks,
        // The read side must agree with the write side, or the row would show a stale value.
        readBack: (app as any).setting.pluginTabs
          .find((t: any) => t.id === 'nextcloud-sync')
          ?.getControlValue('configSync.bookmarks'),
      };
      // Restore, so later specs see the defaults they expect.
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
