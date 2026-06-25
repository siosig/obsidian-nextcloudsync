// Layer B — config-folder sync (CG-1..10) per report/mock_test.md §3.G.
// Exercises ConfigSyncResolver.isIncluded() (pure). Part of the e2e suite as Layer B logic.
// Feature 029: the five config-sync categories collapsed into two — Bookmarks + Other settings.
// CG-2..CG-5 now verify each former category's files are included via the single `others` toggle,
// keeping the CG-1..10 clause numbering the coverage catalog (clauses.ts) pins.
import { DavSyncSettings, DEFAULT_SETTINGS, ConfigSyncCategories } from '../../../src/types';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { ConfigSyncResolver } from '../../../src/sync/ConfigSyncResolver';

const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
const ALL_OFF: ConfigSyncCategories = { bookmarks: false, others: false };

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
    expect(r.isIncluded(p('bookmarks.json'))).toBe(false);
  });

  // CG-2..CG-5: the former appearance / themes-snippets / hotkeys / core-plugins categories are
  // now folded into the single "Other settings" (others) toggle; each former group's files are
  // included when `others` is on.
  it('CG-2 Other settings includes appearance.json / app.json', () => {
    const r = resolver(true, { ...ALL_OFF, others: true });
    expect(r.isIncluded(p('appearance.json'))).toBe(true);
    expect(r.isIncluded(p('app.json'))).toBe(true);
  });

  it('CG-3 Other settings includes themes/ and snippets/', () => {
    const r = resolver(true, { ...ALL_OFF, others: true });
    expect(r.isIncluded(p('themes/dark/theme.css'))).toBe(true);
    expect(r.isIncluded(p('snippets/s.css'))).toBe(true);
  });

  it('CG-4 Other settings includes hotkeys.json', () => {
    const r = resolver(true, { ...ALL_OFF, others: true });
    expect(r.isIncluded(p('hotkeys.json'))).toBe(true);
  });

  it('CG-5 Other settings includes core-plugin config, but NOT bookmarks.json', () => {
    const r = resolver(true, { ...ALL_OFF, others: true });
    expect(r.isIncluded(p('core-plugins.json'))).toBe(true);
    expect(r.isIncluded(p('graph.json'))).toBe(true);
    // bookmarks.json belongs to the Bookmarks category, not Other settings.
    expect(r.isIncluded(p('bookmarks.json'))).toBe(false);
  });

  it('CG-6 Bookmarks only', () => {
    const r = resolver(true, { ...ALL_OFF, bookmarks: true });
    expect(r.isIncluded(p('bookmarks.json'))).toBe(true);
    expect(r.isIncluded(p('appearance.json'))).toBe(false);
    expect(r.isIncluded(p('graph.json'))).toBe(false);
  });

  it('CG-7 both categories enabled', () => {
    const r = resolver(true, { bookmarks: true, others: true });
    expect(r.isIncluded(p('appearance.json'))).toBe(true);
    expect(r.isIncluded(p('themes/t.css'))).toBe(true);
    expect(r.isIncluded(p('hotkeys.json'))).toBe(true);
    expect(r.isIncluded(p('graph.json'))).toBe(true);
    expect(r.isIncluded(p('bookmarks.json'))).toBe(true);
    // C5: device-specific / unknown files are still excluded even with both categories on.
    expect(r.isIncluded(p('workspace.json'))).toBe(false);
    expect(r.isIncluded(p('something-unknown.json'))).toBe(false);
  });

  it('CG-8 hard exclusions: plugins/ and the plugin dir are never included', () => {
    const r = resolver(true, { bookmarks: true, others: true });
    expect(r.isIncluded(p('plugins/some-plugin/main.js'))).toBe(false);
    expect(r.isIncluded(`${PLUGIN_DIR}/data.json`)).toBe(false);
    expect(r.isIncluded(`${PLUGIN_DIR}/state-x.json`)).toBe(false);
  });

  it('CG-9 included config file routes to newest-wins path (isConfigFolderConflictPath)', () => {
    const r = resolver(true, { ...ALL_OFF, others: true });
    expect(r.isConfigFolderConflictPath(p('appearance.json'))).toBe(true);
    // A non-included config path does not take the newest-wins route.
    expect(r.isConfigFolderConflictPath(p('workspace.json'))).toBe(false);
  });

  // CG-10: equal-mtime tiebreak is decided inside SyncEngine.handleConflict (newest-wins
  // with a stable remote-preferred tiebreak); not observable at the pure resolver level
  // (waived in the coverage catalog as DEFER_HARNESS).
  it.skip('CG-10 equal-mtime tiebreak (engine-level newest-wins)', () => undefined);
});
