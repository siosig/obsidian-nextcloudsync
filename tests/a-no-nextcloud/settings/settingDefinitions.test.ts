// [SPEC:DSD-1] [SPEC:DSD-2] [SPEC:DSD-3] [SPEC:DSD-4] Declarative settings definitions (feature 077).
//
// The settings tab moved from an imperative `display()` to Obsidian's declarative
// `getSettingDefinitions()` (1.13.0+), because the search index is built ONLY from that array —
// so before this feature none of the plugin's settings could be found by name.
//
// The migration's real hazard is not the rendering. It is that a `key` typo silently detaches one
// row from its stored value: the row still renders, the user still changes it, and nothing is
// persisted. That failure is invisible in a screenshot, so it is pinned here instead — every
// control's `key` is checked against DEFAULT_SETTINGS, both directions.
//
// The coverage is deliberately asymmetric, and the asymmetry is the point:
//   - `control` rows carry a `key`, so key/type integrity IS checkable (about 14 rows)
//   - `render` rows carry no key, so it ISN'T (about 10 rows) — for those the assertions are
//     presence, order and search visibility only. Clarification #7 records why those rows exist:
//     the numeric input beside each slider (spec 036, a touch-reachability fix) and the
//     SecretComponent for the app password have no declarative equivalent, and dropping them to
//     satisfy a lint warning would trade a real affordance for a formality.
//
// Row counts come from specs/077-declarative-settings/baseline.md, captured from the imperative
// implementation BEFORE it was replaced. Three successive miscounts while producing that baseline
// are why the expected values are hardcoded here rather than derived: a derivation that silently
// skips a row produces a green test that asserts the wrong shape.
import type { SettingDefinitionItem, SettingDefinitionGroup } from 'obsidian';
import {
  buildSettingDefinitions,
  RENDER_ONLY_ROWS,
  UI_LESS_SETTING_KEYS,
  type SettingDefinitionsHost,
} from '../../../src/settings/settingDefinitions';
import { DEFAULT_SETTINGS, type DavSyncSettings } from '../../../src/types';

/** Static structure captured from the pre-migration implementation (baseline.md). */
const BASELINE: { heading: string | null; rows: string[] }[] = [
  { heading: null, rows: ['Sync now'] },
  {
    heading: 'Nextcloud',
    rows: [
      'Server URL',
      'Log in via browser (Nextcloud) — recommended',
      'Username',
      'App password',
      'Sync folder',
      'Sync target (WebDAV)',
    ],
  },
  {
    heading: 'Sync',
    rows: [
      'Startup sync delay (seconds)',
      'Sync interval (minutes)',
      'Network timeout (seconds)',
      'Network concurrency',
      'Sync on Wi-Fi only',
      'Sync on file change',
      'Maximum file size (MB)',
    ],
  },
  {
    heading: 'Conflict resolution',
    rows: [
      'Auto merge file types',
      'Auto merge file strategy',
      'Other file strategy',
      'Frontmatter strategy',
      'Conflict strategy',
    ],
  },
  { heading: 'Excluded folders', rows: ['Excluded folders', 'Add excluded folder'] },
  { heading: 'Config folder (.obsidian)', rows: ['Sync config folder'] },
  { heading: 'Debug', rows: ['Enable logging (troubleshooting)'] },
  { heading: 'Advanced (use with caution)', rows: ['Mass-delete safety limit'] },
  { heading: 'Maintenance', rows: ['Reset vault index', 'Mirror from remote', 'Last session summary'] },
];

const STATIC_ROW_COUNT = BASELINE.reduce((n, s) => n + s.rows.length, 0); // 27

function makeHost(over: Partial<SettingDefinitionsHost> = {}): SettingDefinitionsHost {
  return {
    settings: { ...DEFAULT_SETTINGS },
    isMobile: false,
    isIosApp: false,
    isSignedIn: true,
    configDir: '.obsidian',
    vaultName: 'TestVault',
    syncTargetUrl: () => 'https://example.invalid/dav/TestVault',
    runSyncNow: () => undefined,
    runRemoteMirror: () => undefined,
    resetVaultIndex: () => undefined,
    openSyncStatus: () => undefined,
    startLoginFlow: () => undefined,
    addExcludedFolder: () => undefined,
    removeExcludedFolder: () => undefined,
    renderAppPassword: () => undefined,
    renderNumberSlider: () => undefined,
    renderReadOnly: () => undefined,
    renderNotice: () => undefined,
    renderExtensionList: () => undefined,
    renderAddExcludedFolder: () => undefined,
    ...over,
  };
}

const isGroup = (i: SettingDefinitionItem): i is SettingDefinitionGroup =>
  (i as SettingDefinitionGroup).type === 'group' || (i as SettingDefinitionGroup).type === 'list';

/** Flatten to (section heading, row definition) pairs in render order. */
function flatten(items: SettingDefinitionItem[]): { heading: string | null; row: any }[] {
  const out: { heading: string | null; row: any }[] = [];
  for (const item of items) {
    if (isGroup(item)) {
      for (const child of item.items ?? []) out.push({ heading: item.heading ?? null, row: child });
    } else {
      out.push({ heading: null, row: item });
    }
  }
  return out;
}

const rowsOf = (items: SettingDefinitionItem[]) => flatten(items).map((f) => f.row);
const controlRows = (items: SettingDefinitionItem[]) => rowsOf(items).filter((r) => r.control);

/**
 * Rows that represent a setting, i.e. everything the baseline captured.
 *
 * The old implementation drew banners, help paragraphs, dividers and the caution block as raw
 * elements, not as `Setting` rows, so they were never in the baseline's 27. Declaratively they have
 * to become rows — there is nowhere else to put them — so they are filtered out here rather than
 * retro-fitted into the baseline, which would make the baseline stop describing what it captured.
 */
const settingRowsIn = (items: SettingDefinitionItem[]) =>
  flatten(items).filter((f) => !RENDER_ONLY_ROWS.decorations.includes(f.row.name));

describe('[SPEC:DSD-1] structure matches the pre-migration baseline', () => {
  it('returns a non-empty array — an empty one would fall back to the deleted display()', () => {
    // Not a formality. `display()` is only called when getSettingDefinitions() returns empty
    // (obsidian.d.ts:6633), and feature 077 deletes display(), so an empty return renders NOTHING.
    expect(buildSettingDefinitions(makeHost()).length).toBeGreaterThan(0);
  });

  it('has the same section headings, in the same order', () => {
    const items = buildSettingDefinitions(makeHost());
    // The first group carries no heading — the pre-migration tab opened with "Sync now" above the
    // first `setHeading()` call, and that shape is preserved.
    const headings = items.filter(isGroup).map((g) => g.heading).filter((h) => h !== undefined);
    expect(headings).toEqual(BASELINE.filter((s) => s.heading !== null).map((s) => s.heading));
  });

  it('has the same rows, in the same order, within each section', () => {
    const flat = settingRowsIn(buildSettingDefinitions(makeHost()));
    const expected = BASELINE.flatMap((s) => s.rows.map((r) => ({ heading: s.heading, name: r })));
    expect(flat.map((f) => ({ heading: f.heading, name: f.row.name }))).toEqual(expected);
  });

  it('[SPEC:DBG-1] keeps the Debug section a single toggle', () => {
    // Feature 032 removed the device-name and log-folder inputs so every user converges on one
    // path. That guarantee used to live in the tooltip catalog test, which feature 077 deleted
    // along with tooltips; it moves here rather than lapsing.
    const debug = buildSettingDefinitions(makeHost())
      .filter(isGroup)
      .find((g) => g.heading === 'Debug')!;
    expect((debug.items ?? []).map((i: any) => i.name)).toEqual(['Enable logging (troubleshooting)']);
  });

  it('resolves the config-folder heading from the host, not a hardcoded ".obsidian"', () => {
    const items = buildSettingDefinitions(makeHost({ configDir: '.my-config' }));
    const headings = items.filter(isGroup).map((g) => g.heading);
    expect(headings).toContain('Config folder (.my-config)');
    expect(headings).not.toContain('Config folder (.obsidian)');
  });
});

describe('[SPEC:DSD-2] row count is dynamic, not a constant', () => {
  // baseline.md, "further correction": the imperative tab rendered one row per excluded folder and
  // two more when config sync was on. Asserting a fixed count would pass while silently dropping
  // every dynamic row.
  it('adds one row per excluded folder', () => {
    const none = settingRowsIn(buildSettingDefinitions(makeHost())).length;
    const three = settingRowsIn(
      buildSettingDefinitions(
        makeHost({ settings: { ...DEFAULT_SETTINGS, excludedFolders: ['a', 'b', 'c'] } }),
      ),
    ).length;
    expect(none).toBe(STATIC_ROW_COUNT);
    expect(three).toBe(STATIC_ROW_COUNT + 3);
  });

  it('adds the two config-sync category rows only while the master toggle is on', () => {
    const off = settingRowsIn(buildSettingDefinitions(makeHost())).length;
    const on = settingRowsIn(
      buildSettingDefinitions(makeHost({ settings: { ...DEFAULT_SETTINGS, syncConfigFolder: true } })),
    ).length;
    expect(off).toBe(STATIC_ROW_COUNT);
    expect(on).toBe(STATIC_ROW_COUNT + 2);
  });
});

describe('[SPEC:DSD-3] every control key is real, unique and correctly typed', () => {
  it('binds every control to a key that exists in DEFAULT_SETTINGS', () => {
    const unknown = controlRows(buildSettingDefinitions(makeHost()))
      .map((r) => (r.control.key as string).split('.')[0])
      .filter((k) => !(k in DEFAULT_SETTINGS));
    // A key that is not in DEFAULT_SETTINGS renders fine and persists nothing.
    expect(unknown).toEqual([]);
  });

  it('never binds two rows to the same key', () => {
    const keys = controlRows(buildSettingDefinitions(makeHost({
      settings: { ...DEFAULT_SETTINGS, syncConfigFolder: true },
    }))).map((r) => r.control.key as string);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('matches each control type to the stored value type', () => {
    const expectedType: Record<string, string[]> = {
      toggle: ['boolean'],
      slider: ['number'],
      number: ['number'],
      text: ['string'],
      textarea: ['string'],
      dropdown: ['string'],
      folder: ['string'],
      file: ['string'],
      color: ['string'],
    };
    const mismatches: string[] = [];
    for (const row of controlRows(buildSettingDefinitions(makeHost({
      settings: { ...DEFAULT_SETTINGS, syncConfigFolder: true },
    })))) {
      const key = row.control.key as string;
      // Dotted keys address a nested value (configSync.bookmarks); resolve the path.
      const stored = key.split('.').reduce<unknown>(
        (o, seg) => (o == null ? undefined : (o as Record<string, unknown>)[seg]),
        DEFAULT_SETTINGS as unknown,
      );
      // configSync holds a nested object; its category rows bind through their own keys.
      if (stored === undefined || stored === null) continue;
      const allowed = expectedType[row.control.type as string];
      if (allowed && !allowed.includes(typeof stored)) {
        mismatches.push(`${key}: control=${row.control.type} stored=${typeof stored}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('surfaces every setting that should have a UI, and declares the ones that should not', () => {
    // The reverse direction. Without it, a row can be dropped during the migration and no test
    // notices — the settings file still holds the value, but nothing can change it any more.
    const bound = new Set(
      controlRows(buildSettingDefinitions(makeHost({
        settings: { ...DEFAULT_SETTINGS, syncConfigFolder: true },
      }))).map((r) => (r.control.key as string).split('.')[0]),
    );
    const missing = Object.keys(DEFAULT_SETTINGS).filter(
      (k) => !bound.has(k) && !UI_LESS_SETTING_KEYS.includes(k as keyof DavSyncSettings)
        && !RENDER_ONLY_ROWS.settingKeys.includes(k as keyof DavSyncSettings),
    );
    expect(missing).toEqual([]);
  });

  it('keeps the ui-less and render-only key lists honest (no stale entries)', () => {
    const all = Object.keys(DEFAULT_SETTINGS);
    const stale = [...UI_LESS_SETTING_KEYS, ...RENDER_ONLY_ROWS.settingKeys].filter(
      (k) => !all.includes(k as string),
    );
    // An explicit allow-list rots silently unless something checks it against reality.
    expect(stale).toEqual([]);
  });
});

describe('[SPEC:DSD-4] search visibility is precise', () => {
  it('excludes decorations from search, and only decorations', () => {
    const items = buildSettingDefinitions(makeHost());
    const notSearchable = rowsOf(items).filter((r) => r.searchable === false).map((r) => r.name);
    // Decorations are rows that carry no setting: banners, help text, dividers, warnings. A default
    // host has no excluded folders, so no list entries are present to widen this set.
    const expected = RENDER_ONLY_ROWS.decorations.filter((d) =>
      rowsOf(items).some((r) => r.name === d));
    expect(notSearchable.sort()).toEqual([...expected].sort());
  });

  it('leaves every real setting searchable', () => {
    const baselineNames = new Set(BASELINE.flatMap((s) => s.rows));
    const hidden = rowsOf(buildSettingDefinitions(makeHost()))
      .filter((r) => r.searchable === false && baselineNames.has(r.name));
    // SC-001 is the whole point of the feature; a stray searchable:false silently undoes it.
    expect(hidden.map((r) => r.name)).toEqual([]);
  });

  it('attaches aliases only to real settings', () => {
    const baselineNames = new Set(BASELINE.flatMap((s) => s.rows));
    const aliased = rowsOf(buildSettingDefinitions(makeHost())).filter((r) => r.aliases?.length);
    expect(aliased.length).toBeGreaterThanOrEqual(10);
    expect(aliased.filter((r) => !baselineNames.has(r.name)).map((r) => r.name)).toEqual([]);
  });

  it('gives every non-heading row a description (the old tooltip coverage guarantee, moved)', () => {
    // settingsTooltips.test.ts guaranteed every row carried supplementary help. Tooltips are gone
    // (Clarification #6 folded them into desc, where mobile can finally see them); the guarantee
    // moves here rather than disappearing with them.
    const undocumented = rowsOf(buildSettingDefinitions(makeHost()))
      .filter((r) => !r.desc)
      .map((r) => r.name);
    expect(undocumented).toEqual([]);
  });
});

describe('[SPEC:DSD-5] predicates reflect platform and sign-in state', () => {
  const rowNamed = (host: SettingDefinitionsHost, name: string) =>
    rowsOf(buildSettingDefinitions(host)).find((r) => r.name === name)!;

  const isDisabled = (row: any): boolean => {
    const d = row.control?.disabled ?? row.disabled;
    return typeof d === 'function' ? !!d() : !!d;
  };

  it('disables "Sync on Wi-Fi only" on iOS only', () => {
    expect(isDisabled(rowNamed(makeHost({ isIosApp: true, isMobile: true }), 'Sync on Wi-Fi only'))).toBe(true);
    expect(isDisabled(rowNamed(makeHost({ isIosApp: false }), 'Sync on Wi-Fi only'))).toBe(false);
  });

  it('disables "Sync on file change" on every mobile platform', () => {
    expect(isDisabled(rowNamed(makeHost({ isMobile: true }), 'Sync on file change'))).toBe(true);
    expect(isDisabled(rowNamed(makeHost({ isMobile: false }), 'Sync on file change'))).toBe(false);
  });

  it('disables "Sync now" until the credentials are complete', () => {
    expect(isDisabled(rowNamed(makeHost({ isSignedIn: false }), 'Sync now'))).toBe(true);
    expect(isDisabled(rowNamed(makeHost({ isSignedIn: true }), 'Sync now'))).toBe(false);
  });

  it('shows the not-signed-in banner only while signed out', () => {
    const visible = (host: SettingDefinitionsHost): boolean => {
      const row = rowsOf(buildSettingDefinitions(host)).find((r) => r.name === RENDER_ONLY_ROWS.authBanner);
      if (!row) return false;
      return typeof row.visible === 'function' ? !!row.visible() : row.visible !== false;
    };
    expect(visible(makeHost({ isSignedIn: false }))).toBe(true);
    expect(visible(makeHost({ isSignedIn: true }))).toBe(false);
  });
});
