import { ConfigSyncCategories, DavSyncSettings } from '../types';
import { LocalAdapter } from '../data/LocalAdapter';

/**
 * Fixed allowlist of known Obsidian core-plugin config filenames (relative to the config dir)
 * claimed by the "Core plugin settings" category. A fixed allowlist (not a denylist of
 * "everything uncategorized") is used deliberately so device-specific files like
 * `workspace.json` and unknown/community-origin files are never swept in.
 *
 * `bookmarks.json` is intentionally absent — it is owned by the dedicated Bookmarks category
 * (single ownership). This is a data list: it can be extended in one place as Obsidian ships
 * new core plugins, with no logic change.
 */
export const CORE_PLUGIN_CONFIG_FILES: readonly string[] = [
  'core-plugins.json',
  'core-plugins-migration.json',
  'graph.json',
  'daily-notes.json',
  'templates.json',
  'note-composer.json',
  'command-palette.json',
  'zk-prefixer.json',
  'random-note.json',
  'outgoing-links.json',
  'backlink.json',
  'page-preview.json',
  'file-recovery.json',
  'sync.json',
  'canvas.json',
  'switcher.json',
  'slash-command.json',
  'properties.json',
  'tag-pane.json',
  'outline.json',
  'word-count.json',
  'audio-recorder.json',
  'slides.json',
  'markdown-importer.json',
  'file-explorer.json',
  'global-search.json',
  'starred.json',
  'workspaces.json',
];

/** One config-sync category: a UI-facing label/description plus a pure path matcher. */
export interface ConfigSyncCategoryDescriptor {
  key: keyof ConfigSyncCategories;
  label: string;
  description: string;
  /** True when `rel` (a path relative to the config dir) belongs to this category. */
  matches(rel: string): boolean;
}

/**
 * The five config-sync categories. This single list drives BOTH the include decision
 * (iterate enabled categories) and the settings UI (one toggle per descriptor), so the UI
 * and the sync logic cannot drift apart.
 */
export const CONFIG_SYNC_CATEGORIES: readonly ConfigSyncCategoryDescriptor[] = [
  {
    key: 'appearance',
    label: 'Appearance',
    description: 'Appearance and base settings (appearance.json, app.json) — theme mode, fonts, base settings.',
    matches: (rel) => rel === 'appearance.json' || rel === 'app.json',
  },
  {
    key: 'themesSnippets',
    label: 'Themes & snippets',
    description: 'Installed themes and CSS snippets (themes/, snippets/). CSS only — no executable code.',
    matches: (rel) => rel.startsWith('themes/') || rel.startsWith('snippets/'),
  },
  {
    key: 'hotkeys',
    label: 'Hotkeys',
    description: 'Custom keyboard shortcuts (hotkeys.json).',
    matches: (rel) => rel === 'hotkeys.json',
  },
  {
    key: 'corePlugins',
    label: 'Core plugin settings',
    description: 'Enabled core plugins and their settings (core-plugins.json, graph.json, etc.). A restart may be needed to apply on the other device.',
    matches: (rel) => CORE_PLUGIN_CONFIG_FILES.includes(rel),
  },
  {
    key: 'bookmarks',
    label: 'Bookmarks',
    description: 'Obsidian bookmarks (bookmarks.json).',
    matches: (rel) => rel === 'bookmarks.json',
  },
];

export interface ConfigSyncResolverOptions {
  /** Vault#configDir, e.g. `.obsidian` (user-relocatable). All paths resolve against this. */
  configDir: string;
  /** Live settings reference (read on every call, so toggles take effect without a rebuild). */
  settings: Pick<DavSyncSettings, 'syncConfigFolder' | 'configSync'>;
  /**
   * This plugin's own directory (`<configDir>/plugins/<id>`), holding the sync-state DB and
   * data.json. A hard exclusion — never synced. (Already covered by the `plugins/` rule, but
   * kept explicit as defense-in-depth per FR-004.)
   */
  pluginDir: string;
  /** Used only by `enumerateIncludedPaths` to list/stat included files. */
  localAdapter: Pick<LocalAdapter, 'list' | 'stat'>;
}

/**
 * Single source of truth for "does this config-folder path sync, and which config paths should
 * be injected into the local scan". `SyncEngine.isSystemExcluded`, the remote-file filter, and
 * the remote-deletion scope guard all consult `isIncluded`, so exclusion (and the FR-008 safety
 * guarantee) is defined in exactly one place.
 */
export class ConfigSyncResolver {
  constructor(private readonly opts: ConfigSyncResolverOptions) {}

  /** Path relative to configDir, or null if `path` is not under (or equal to) the config dir. */
  private rel(path: string): string | null {
    const cd = this.opts.configDir;
    if (path === cd) return '';
    const prefix = `${cd}/`;
    if (!path.startsWith(prefix)) return null;
    return path.slice(prefix.length);
  }

  /** True if `path` is the config dir itself or anything under it. */
  isUnderConfigDir(path: string): boolean {
    return this.rel(path) !== null;
  }

  private isUnderPluginDir(path: string): boolean {
    const pd = this.opts.pluginDir;
    return path === pd || path.startsWith(`${pd}/`);
  }

  /**
   * Whether a config-folder path is included in the sync given current settings. Pure (no I/O).
   * Hard exclusions (plugins/, the plugin dir) are evaluated before category matching, so no
   * toggle combination can ever include community-plugin code or the sync-state DB.
   */
  isIncluded(path: string): boolean {
    const rel = this.rel(path);
    if (rel === null) return false;                 // not under configDir
    if (rel === '') return false;                   // the dir itself is not a file
    if (!this.opts.settings.syncConfigFolder) return false; // C1: master off
    // C2/C3: hard exclusions win over every category toggle.
    if (this.isUnderPluginDir(path)) return false;
    if (rel === 'plugins' || rel.startsWith('plugins/')) return false;
    // C4: any enabled category that claims this path.
    const cs = this.opts.settings.configSync;
    for (const cat of CONFIG_SYNC_CATEGORIES) {
      if (cs[cat.key] && cat.matches(rel)) return true;
    }
    return false; // C5
  }

  /** True iff `path` is an included config-folder file (used to route conflicts to newest-wins). */
  isConfigFolderConflictPath(path: string): boolean {
    return this.isUnderConfigDir(path) && this.isIncluded(path);
  }

  /**
   * Concrete config-folder paths to inject into the local scan. Enumerates only what is in
   * scope — fixed files that exist + a recursive listing of themes/ and snippets/. Never lists
   * `plugins/`. Every returned path P satisfies `isIncluded(P) === true`.
   */
  async enumerateIncludedPaths(): Promise<string[]> {
    if (!this.opts.settings.syncConfigFolder) return [];
    const cd = this.opts.configDir;
    const cs = this.opts.settings.configSync;
    const out: string[] = [];

    const exactFiles: string[] = [];
    if (cs.appearance) exactFiles.push('appearance.json', 'app.json');
    if (cs.hotkeys) exactFiles.push('hotkeys.json');
    if (cs.bookmarks) exactFiles.push('bookmarks.json');
    if (cs.corePlugins) exactFiles.push(...CORE_PLUGIN_CONFIG_FILES);
    for (const rel of exactFiles) {
      const p = `${cd}/${rel}`;
      const st = await this.opts.localAdapter.stat(p);
      if (st) out.push(p);
    }

    if (cs.themesSnippets) {
      await this.listRecursive(`${cd}/themes`, out);
      await this.listRecursive(`${cd}/snippets`, out);
    }

    return Array.from(new Set(out));
  }

  private async listRecursive(dir: string, out: string[]): Promise<void> {
    try {
      const listing = await this.opts.localAdapter.list(dir);
      for (const f of listing.files) out.push(f);
      for (const sub of listing.folders) await this.listRecursive(sub, out);
    } catch {
      /* directory absent or unreadable — nothing to inject */
    }
  }
}
