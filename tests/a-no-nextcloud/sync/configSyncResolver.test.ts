import {
  ConfigSyncResolver,
  CONFIG_SYNC_CATEGORIES,
  CORE_PLUGIN_CONFIG_FILES,
} from '../../../src/sync/ConfigSyncResolver';
import { ConfigSyncCategories } from '../../../src/types';

const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;

function categories(overrides: Partial<ConfigSyncCategories> = {}): ConfigSyncCategories {
  return {
    appearance: false,
    themesSnippets: false,
    hotkeys: false,
    corePlugins: false,
    bookmarks: false,
    ...overrides,
  };
}

/** Minimal in-memory LocalAdapter for enumeration tests. */
function makeAdapter(tree: { files: Record<string, true>; dirs: Record<string, { files: string[]; folders: string[] }> }) {
  return {
    stat: jest.fn(async (p: string) => (tree.files[p] ? { size: 1, mtime: 1 } : null)),
    list: jest.fn(async (dir: string) => tree.dirs[dir] ?? { files: [], folders: [] }),
  };
}

function makeResolver(opts: {
  syncConfigFolder: boolean;
  configSync?: Partial<ConfigSyncCategories>;
  configDir?: string;
  adapter?: ReturnType<typeof makeAdapter>;
}) {
  const configDir = opts.configDir ?? CONFIG_DIR;
  return new ConfigSyncResolver({
    configDir,
    settings: { syncConfigFolder: opts.syncConfigFolder, configSync: categories(opts.configSync) },
    pluginDir: `${configDir}/plugins/nextcloud-sync`,
    localAdapter: opts.adapter ?? (makeAdapter({ files: {}, dirs: {} }) as never),
  });
}

describe('ConfigSyncResolver.isIncluded', () => {
  // C1: master off → every config path excluded, even with categories that would match.
  it('C1: excludes all config paths when the master toggle is off', () => {
    const r = makeResolver({ syncConfigFolder: false, configSync: { appearance: true, themesSnippets: true, bookmarks: true } });
    expect(r.isIncluded(`${CONFIG_DIR}/appearance.json`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/themes/x.css`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/bookmarks.json`)).toBe(false);
  });

  // Not under configDir → never excluded by the resolver (ordinary vault files).
  it('returns false for paths outside the config dir', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { appearance: true } });
    expect(r.isIncluded('Notes/a.md')).toBe(false);
    expect(r.isUnderConfigDir('Notes/a.md')).toBe(false);
  });

  // The config dir entry itself is not a syncable file.
  it('returns false for the config dir itself', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { appearance: true } });
    expect(r.isIncluded(CONFIG_DIR)).toBe(false);
    expect(r.isUnderConfigDir(CONFIG_DIR)).toBe(true);
  });

  // C2/C3: hard exclusions beat every category, even with ALL categories enabled.
  it('C2/C3: never includes plugins/** or the plugin state DB even with all categories on', () => {
    const r = makeResolver({
      syncConfigFolder: true,
      configSync: { appearance: true, themesSnippets: true, hotkeys: true, corePlugins: true, bookmarks: true },
    });
    expect(r.isIncluded(`${CONFIG_DIR}/plugins/some-plugin/main.js`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/plugins/some-plugin/data.json`)).toBe(false);
    expect(r.isIncluded(`${PLUGIN_DIR}/state.json`)).toBe(false);
    expect(r.isIncluded(`${PLUGIN_DIR}/data.json`)).toBe(false);
  });

  // C4: each category in isolation includes exactly its files and nothing from other categories.
  it('C4: Appearance includes only appearance.json/app.json', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { appearance: true } });
    expect(r.isIncluded(`${CONFIG_DIR}/appearance.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/app.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/hotkeys.json`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/themes/x.css`)).toBe(false);
  });

  it('C4: Themes & snippets includes themes/** and snippets/** only', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { themesSnippets: true } });
    expect(r.isIncluded(`${CONFIG_DIR}/themes/Cool/theme.css`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/snippets/tweak.css`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/appearance.json`)).toBe(false);
  });

  it('C4: Hotkeys includes only hotkeys.json', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { hotkeys: true } });
    expect(r.isIncluded(`${CONFIG_DIR}/hotkeys.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/app.json`)).toBe(false);
  });

  it('C4: Core plugin settings includes the allowlist but NOT bookmarks.json', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { corePlugins: true } });
    expect(r.isIncluded(`${CONFIG_DIR}/core-plugins.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/graph.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/daily-notes.json`)).toBe(true);
    // bookmarks.json is owned by the Bookmarks category, not Core plugin settings.
    expect(CORE_PLUGIN_CONFIG_FILES).not.toContain('bookmarks.json');
    expect(r.isIncluded(`${CONFIG_DIR}/bookmarks.json`)).toBe(false);
  });

  it('C4: Bookmarks includes only bookmarks.json', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { bookmarks: true } });
    expect(r.isIncluded(`${CONFIG_DIR}/bookmarks.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/graph.json`)).toBe(false);
  });

  // C5: device-specific / unknown files excluded even with everything on.
  it('C5: excludes workspace.json and unknown files even with all categories on', () => {
    const r = makeResolver({
      syncConfigFolder: true,
      configSync: { appearance: true, themesSnippets: true, hotkeys: true, corePlugins: true, bookmarks: true },
    });
    expect(r.isIncluded(`${CONFIG_DIR}/workspace.json`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/workspace-mobile.json`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/something-unknown.json`)).toBe(false);
  });

  // Relocated config dir must still match (no hardcoded `.obsidian`).
  it('works with a relocated config directory', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { appearance: true }, configDir: '.config-obsidian' });
    expect(r.isIncluded('.config-obsidian/appearance.json')).toBe(true);
    expect(r.isIncluded('.obsidian/appearance.json')).toBe(false);
  });

  it('isConfigFolderConflictPath matches included config paths only', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { appearance: true } });
    expect(r.isConfigFolderConflictPath(`${CONFIG_DIR}/appearance.json`)).toBe(true);
    expect(r.isConfigFolderConflictPath(`${CONFIG_DIR}/workspace.json`)).toBe(false);
    expect(r.isConfigFolderConflictPath('Notes/a.md')).toBe(false);
  });
});

describe('ConfigSyncResolver.enumerateIncludedPaths', () => {
  it('returns [] when the master toggle is off', async () => {
    const r = makeResolver({ syncConfigFolder: false, configSync: { appearance: true } });
    expect(await r.enumerateIncludedPaths()).toEqual([]);
  });

  it('omits allowlist files that do not exist', async () => {
    const adapter = makeAdapter({ files: { [`${CONFIG_DIR}/appearance.json`]: true }, dirs: {} });
    const r = makeResolver({ syncConfigFolder: true, configSync: { appearance: true }, adapter });
    // app.json absent → only appearance.json returned.
    expect(await r.enumerateIncludedPaths()).toEqual([`${CONFIG_DIR}/appearance.json`]);
  });

  it('recurses themes/ and snippets/ and never returns plugins/', async () => {
    const adapter = makeAdapter({
      files: {},
      dirs: {
        [`${CONFIG_DIR}/themes`]: { files: [`${CONFIG_DIR}/themes/Cool/theme.css`], folders: [`${CONFIG_DIR}/themes/Cool`] },
        [`${CONFIG_DIR}/themes/Cool`]: { files: [`${CONFIG_DIR}/themes/Cool/theme.css`], folders: [] },
        [`${CONFIG_DIR}/snippets`]: { files: [`${CONFIG_DIR}/snippets/tweak.css`], folders: [] },
      },
    });
    const r = makeResolver({ syncConfigFolder: true, configSync: { themesSnippets: true }, adapter });
    const paths = await r.enumerateIncludedPaths();
    expect(paths).toEqual(expect.arrayContaining([`${CONFIG_DIR}/snippets/tweak.css`, `${CONFIG_DIR}/themes/Cool/theme.css`]));
    expect(paths.some(p => p.includes('/plugins/'))).toBe(false);
    // Every enumerated path must agree with the predicate.
    for (const p of paths) expect(r.isIncluded(p)).toBe(true);
  });
});

describe('CONFIG_SYNC_CATEGORIES', () => {
  it('exposes exactly the five settings keys for the UI', () => {
    expect(CONFIG_SYNC_CATEGORIES.map(c => c.key)).toEqual([
      'appearance', 'themesSnippets', 'hotkeys', 'corePlugins', 'bookmarks',
    ]);
  });
});
