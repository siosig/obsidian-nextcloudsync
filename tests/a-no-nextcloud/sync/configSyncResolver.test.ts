import {
  ConfigSyncResolver,
  CONFIG_SYNC_CATEGORIES,
  CORE_PLUGIN_CONFIG_FILES,
} from '../../../src/sync/ConfigSyncResolver';
import { ConfigSyncCategories } from '../../../src/types';

const CONFIG_DIR = '.obsidian';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/nextcloud-sync`;

// Feature 029: two categories — Bookmarks and "Other settings" (appearance/themes/hotkeys/core).
function categories(overrides: Partial<ConfigSyncCategories> = {}): ConfigSyncCategories {
  return { bookmarks: false, others: false, ...overrides };
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
    const r = makeResolver({ syncConfigFolder: false, configSync: { others: true, bookmarks: true } });
    expect(r.isIncluded(`${CONFIG_DIR}/appearance.json`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/themes/x.css`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/bookmarks.json`)).toBe(false);
  });

  // Not under configDir → never excluded by the resolver (ordinary vault files).
  it('returns false for paths outside the config dir', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true } });
    expect(r.isIncluded('Notes/a.md')).toBe(false);
    expect(r.isUnderConfigDir('Notes/a.md')).toBe(false);
  });

  // The config dir entry itself is not a syncable file.
  it('returns false for the config dir itself', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true } });
    expect(r.isIncluded(CONFIG_DIR)).toBe(false);
    expect(r.isUnderConfigDir(CONFIG_DIR)).toBe(true);
  });

  // C2/C3: hard exclusions beat every category, even with both categories enabled.
  it('C2/C3: never includes plugins/** or the plugin state DB even with all categories on', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true, bookmarks: true } });
    expect(r.isIncluded(`${CONFIG_DIR}/plugins/some-plugin/main.js`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/plugins/some-plugin/data.json`)).toBe(false);
    expect(r.isIncluded(`${PLUGIN_DIR}/state.json`)).toBe(false);
    expect(r.isIncluded(`${PLUGIN_DIR}/data.json`)).toBe(false);
  });

  // C4: "Other settings" folds appearance/app, themes & snippets, hotkeys, and core plugins.
  it('C4: Other settings includes appearance/app, themes & snippets, hotkeys, and core plugins', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true } });
    expect(r.isIncluded(`${CONFIG_DIR}/appearance.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/app.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/themes/Cool/theme.css`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/snippets/tweak.css`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/hotkeys.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/core-plugins.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/graph.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/daily-notes.json`)).toBe(true);
    // bookmarks.json is owned by the Bookmarks category, not Other settings.
    expect(CORE_PLUGIN_CONFIG_FILES).not.toContain('bookmarks.json');
    expect(r.isIncluded(`${CONFIG_DIR}/bookmarks.json`)).toBe(false);
  });

  it('C4: Bookmarks includes only bookmarks.json', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { bookmarks: true } });
    expect(r.isIncluded(`${CONFIG_DIR}/bookmarks.json`)).toBe(true);
    expect(r.isIncluded(`${CONFIG_DIR}/graph.json`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/appearance.json`)).toBe(false);
  });

  // C5: device-specific / unknown files excluded even with everything on.
  it('C5: excludes workspace.json and unknown files even with all categories on', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true, bookmarks: true } });
    expect(r.isIncluded(`${CONFIG_DIR}/workspace.json`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/workspace-mobile.json`)).toBe(false);
    expect(r.isIncluded(`${CONFIG_DIR}/something-unknown.json`)).toBe(false);
  });

  // Relocated config dir must still match (no hardcoded `.obsidian`).
  it('works with a relocated config directory', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true }, configDir: '.config-obsidian' });
    expect(r.isIncluded('.config-obsidian/appearance.json')).toBe(true);
    expect(r.isIncluded('.obsidian/appearance.json')).toBe(false);
  });

  it('isConfigFolderConflictPath matches included config paths only', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true } });
    expect(r.isConfigFolderConflictPath(`${CONFIG_DIR}/appearance.json`)).toBe(true);
    expect(r.isConfigFolderConflictPath(`${CONFIG_DIR}/workspace.json`)).toBe(false);
    expect(r.isConfigFolderConflictPath('Notes/a.md')).toBe(false);
  });
});

// GitHub issue #12 (feature request: "sync community plugins"). Declined by design — community
// plugins live under `<configDir>/plugins/**` (each an arbitrary third-party bundle: main.js,
// manifest.json, styles.css, data.json, nested assets) and syncing executable plugin code across
// devices is a correctness/security hazard the plugin deliberately does not take on. This is a
// REGRESSION GUARD locking that stance: no toggle combination may ever pull a community plugin's
// files into the sync set. If a future change wants to support it, this test must be updated
// consciously (not silently), forcing the decision back through review.
describe('ConfigSyncResolver — community plugins are never synced (GitHub issue #12)', () => {
  const COMMUNITY_PLUGIN_FILES = [
    `${CONFIG_DIR}/plugins/dataview/main.js`,
    `${CONFIG_DIR}/plugins/dataview/manifest.json`,
    `${CONFIG_DIR}/plugins/dataview/styles.css`,
    `${CONFIG_DIR}/plugins/dataview/data.json`,
    `${CONFIG_DIR}/plugins/templater-obsidian/main.js`,
    `${CONFIG_DIR}/plugins/templater-obsidian/assets/nested/blob.bin`,
  ];

  it('isIncluded is false for every community-plugin file with syncConfigFolder ON and both categories ON', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true, bookmarks: true } });
    for (const p of COMMUNITY_PLUGIN_FILES) expect(r.isIncluded(p)).toBe(false);
  });

  it('isConfigFolderConflictPath never routes a community-plugin file as a config conflict', () => {
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true, bookmarks: true } });
    for (const p of COMMUNITY_PLUGIN_FILES) expect(r.isConfigFolderConflictPath(p)).toBe(false);
  });

  it('enumerateIncludedPaths never lists a community plugin even when plugins/ is populated', async () => {
    // A plugins tree exists on disk; the "others" category recurses themes/ & snippets/ but must
    // NEVER descend into plugins/. Enumeration lists only the theme file, not the plugin bundle.
    const adapter = makeAdapter({
      files: { [`${CONFIG_DIR}/appearance.json`]: true },
      dirs: {
        [`${CONFIG_DIR}/themes`]: { files: [`${CONFIG_DIR}/themes/Cool/theme.css`], folders: [`${CONFIG_DIR}/themes/Cool`] },
        [`${CONFIG_DIR}/themes/Cool`]: { files: [`${CONFIG_DIR}/themes/Cool/theme.css`], folders: [] },
        [`${CONFIG_DIR}/plugins`]: { files: [], folders: [`${CONFIG_DIR}/plugins/dataview`] },
        [`${CONFIG_DIR}/plugins/dataview`]: { files: [`${CONFIG_DIR}/plugins/dataview/main.js`], folders: [] },
      },
    });
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true, bookmarks: true }, adapter });
    const paths = await r.enumerateIncludedPaths();
    expect(paths.some(p => p.includes('/plugins/'))).toBe(false);
    expect(paths).not.toContain(`${CONFIG_DIR}/plugins/dataview/main.js`);
  });
});

describe('ConfigSyncResolver.enumerateIncludedPaths', () => {
  it('returns [] when the master toggle is off', async () => {
    const r = makeResolver({ syncConfigFolder: false, configSync: { others: true } });
    expect(await r.enumerateIncludedPaths()).toEqual([]);
  });

  it('omits allowlist files that do not exist', async () => {
    const adapter = makeAdapter({ files: { [`${CONFIG_DIR}/appearance.json`]: true }, dirs: {} });
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true }, adapter });
    // app.json / hotkeys.json / core-plugin files absent → only appearance.json returned.
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
    const r = makeResolver({ syncConfigFolder: true, configSync: { others: true }, adapter });
    const paths = await r.enumerateIncludedPaths();
    expect(paths).toEqual(expect.arrayContaining([`${CONFIG_DIR}/snippets/tweak.css`, `${CONFIG_DIR}/themes/Cool/theme.css`]));
    expect(paths.some(p => p.includes('/plugins/'))).toBe(false);
    // Every enumerated path must agree with the predicate.
    for (const p of paths) expect(r.isIncluded(p)).toBe(true);
  });
});

describe('CONFIG_SYNC_CATEGORIES', () => {
  it('exposes exactly the two settings keys for the UI (feature 029)', () => {
    expect(CONFIG_SYNC_CATEGORIES.map(c => c.key)).toEqual(['bookmarks', 'others']);
  });
});
