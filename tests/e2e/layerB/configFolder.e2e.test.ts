// Layer B — config-folder sync (CG-1..10) per report/mock_test.md §3.G.
// Exercises ConfigSyncResolver.isIncluded() (pure). Part of the e2e suite as Layer B logic.
import { DavSyncSettings, DEFAULT_SETTINGS, ConfigSyncCategories } from '../../../src/types';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { ConfigSyncResolver } from '../../../src/sync/ConfigSyncResolver';

const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
const ALL_OFF: ConfigSyncCategories = {
  appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false,
};

function resolver(syncConfigFolder: boolean, configSync: ConfigSyncCategories): ConfigSyncResolver {
  const settings: Pick<DavSyncSettings, 'syncConfigFolder' | 'configSync'> = { syncConfigFolder, configSync };
  return new ConfigSyncResolver({
    configDir: CONFIG_DIR,
    settings,
    pluginDir: PLUGIN_DIR,
    localAdapter: {} as unknown as Pick<LocalAdapter, 'list' | 'stat'>,
  });
}

const p = (rel: string): string => `${CONFIG_DIR}/${rel}`;

describe('Layer B — config-folder sync (CG)', () => {
  it('CG-1 master off → nothing under config dir is included', () => {
    const r = resolver(false, { ...DEFAULT_SETTINGS.configSync });
    expect(r.isIncluded(p('appearance.json'))).toBe(false);
    expect(r.isIncluded(p('themes/x.css'))).toBe(false);
  });

  it('CG-2 appearance only', () => {
    const r = resolver(true, { ...ALL_OFF, appearance: true });
    expect(r.isIncluded(p('appearance.json'))).toBe(true);
    expect(r.isIncluded(p('app.json'))).toBe(true);
    expect(r.isIncluded(p('hotkeys.json'))).toBe(false);
  });

  it('CG-3 themes/snippets only', () => {
    const r = resolver(true, { ...ALL_OFF, themesSnippets: true });
    expect(r.isIncluded(p('themes/dark/theme.css'))).toBe(true);
    expect(r.isIncluded(p('snippets/s.css'))).toBe(true);
    expect(r.isIncluded(p('appearance.json'))).toBe(false);
  });

  it('CG-4 hotkeys only', () => {
    const r = resolver(true, { ...ALL_OFF, hotkeys: true });
    expect(r.isIncluded(p('hotkeys.json'))).toBe(true);
    expect(r.isIncluded(p('app.json'))).toBe(false);
  });

  it('CG-5 core plugins only', () => {
    const r = resolver(true, { ...ALL_OFF, corePlugins: true });
    expect(r.isIncluded(p('core-plugins.json'))).toBe(true);
    expect(r.isIncluded(p('graph.json'))).toBe(true);
    expect(r.isIncluded(p('hotkeys.json'))).toBe(false);
  });

  it('CG-6 bookmarks only', () => {
    const r = resolver(true, { ...ALL_OFF, bookmarks: true });
    expect(r.isIncluded(p('bookmarks.json'))).toBe(true);
    expect(r.isIncluded(p('appearance.json'))).toBe(false);
  });

  it('CG-7 all categories enabled', () => {
    const r = resolver(true, { appearance: true, themesSnippets: true, hotkeys: true, corePlugins: true, bookmarks: true });
    expect(r.isIncluded(p('appearance.json'))).toBe(true);
    expect(r.isIncluded(p('themes/t.css'))).toBe(true);
    expect(r.isIncluded(p('hotkeys.json'))).toBe(true);
    expect(r.isIncluded(p('graph.json'))).toBe(true);
    expect(r.isIncluded(p('bookmarks.json'))).toBe(true);
  });

  it('CG-8 hard exclusions: plugins/ and the plugin dir are never included', () => {
    const r = resolver(true, { appearance: true, themesSnippets: true, hotkeys: true, corePlugins: true, bookmarks: true });
    expect(r.isIncluded(p('plugins/some-plugin/main.js'))).toBe(false);
    expect(r.isIncluded(`${PLUGIN_DIR}/data.json`)).toBe(false);
    expect(r.isIncluded(`${PLUGIN_DIR}/state-x.json`)).toBe(false);
  });

  it('CG-9 included config file routes to newest-wins path (isConfigFolderConflictPath)', () => {
    const r = resolver(true, { ...ALL_OFF, appearance: true });
    expect(r.isConfigFolderConflictPath(p('appearance.json'))).toBe(true);
    // A non-included config path does not take the newest-wins route.
    expect(r.isConfigFolderConflictPath(p('hotkeys.json'))).toBe(false);
  });

  // CG-10: equal-mtime tiebreak is decided inside SyncEngine.handleConflict (newest-wins
  // with a stable remote-preferred tiebreak); not observable at the pure resolver level.
  it.skip('CG-10 equal-mtime tiebreak (engine-level newest-wins)', () => undefined);
});
