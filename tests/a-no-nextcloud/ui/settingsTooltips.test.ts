// Exhaustive coverage of settings tooltips (spec 020). Pure: imports the wording
// catalog only, no Obsidian/DOM. Guarantees every non-heading settings row has a
// tooltip defined, the Server URL description carries the 405-prevention info, and
// the sign-in help explains the no-separate-login / browser-or-manual model.
import { TOOLTIPS, SERVER_URL_DESC, SIGN_IN_HELP, CONFIG_CATEGORY_TOOLTIP, TooltipKey } from '../../../src/settings/tooltips';
import { CONFIG_SYNC_CATEGORIES } from '../../../src/sync/ConfigSyncResolver';
import { DEFAULT_SETTINGS } from '../../../src/types';

// The non-heading settings rows that must each carry a tooltip (keys into TOOLTIPS).
// Feature 028: the settings UI is simplified — Sync detail rows, the Merge and Debug sections,
// File locking and Compare-with-remote are removed; the per-log toggles collapse into a single
// loggingEnabled row. The surviving editable rows are listed here.
const EXPECTED_KEYS: TooltipKey[] = [
  'syncNow',
  'serverUrl', 'username', 'appPassword', 'loginViaBrowser', 'syncFolder', 'syncTarget',
  'syncInterval', 'syncOnWifiOnly',
  'syncConfigFolder', 'configAppearance', 'configThemesSnippets', 'configHotkeys', 'configCorePlugins', 'configBookmarks',
  'excludedFolders', 'addExcludedFolder',
  'loggingEnabled', 'resetVaultIndex', 'lastSessionSummary',
];

describe('[SPEC:FR-001] settings tooltips coverage', () => {
  it('[SPEC:FR-006] every expected (non-heading) settings row has a tooltip', () => {
    const missing = EXPECTED_KEYS.filter((k) => !(k in TOOLTIPS));
    expect(missing).toEqual([]);
  });

  it('[SPEC:FR-002] each tooltip is non-empty English (no Japanese characters)', () => {
    for (const [key, text] of Object.entries(TOOLTIPS)) {
      expect(text.trim().length).toBeGreaterThan(0);
      // No hiragana / katakana / CJK unified ideographs (UI strings must be English).
      expect(/[぀-ヿ㐀-鿿]/.test(text)).toBe(false);
    }
  });

  it('[SPEC:FR-005] config-folder categories all map to a defined tooltip', () => {
    for (const cat of CONFIG_SYNC_CATEGORIES) {
      const tip = CONFIG_CATEGORY_TOOLTIP[cat.key];
      expect(tip).toBeDefined();
      expect(TOOLTIPS[tip]).toBeTruthy();
    }
  });
});

describe('[SPEC:FR-007] Server URL description prevents HTTP 405', () => {
  it('states the full endpoint, subfolder allowance, and 405 failure', () => {
    expect(SERVER_URL_DESC).toContain('remote.php/dav/files');
    expect(SERVER_URL_DESC.toLowerCase()).toContain('subfolder');
    expect(SERVER_URL_DESC).toContain('405');
  });
});

describe('[SPEC:FR-010] sign-in help explains the model', () => {
  it('covers browser-or-manual alternatives, recommended browser, no separate login, verified next sync', () => {
    const h = SIGN_IN_HELP.toLowerCase();
    expect(h).toContain('recommended');           // browser path is recommended
    expect(h).toContain('manually');               // manual alternative
    expect(h).toContain('alternatives');           // they are alternatives, not both
    expect(h).toContain('no separate');            // no separate login action
    expect(h).toContain('next sync');              // verified on next sync
  });
});

describe('[SPEC:FR-014] no new settings introduced by the tooltip feature', () => {
  it('DEFAULT_SETTINGS does not gain tooltip-related keys', () => {
    const keys = Object.keys(DEFAULT_SETTINGS);
    expect(keys).not.toContain('tooltip');
    expect(keys).not.toContain('tooltips');
    expect(keys).not.toContain('TOOLTIPS');
  });
});
