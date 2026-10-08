import { ConfigSyncCategories, DavSyncSettings } from '../types';
import { LocalAdapter } from '../data/LocalAdapter';

// An allowlist, not a denylist, so device-specific files (`workspace.json`) and community-origin files
// are never swept in. `bookmarks.json` is absent on purpose: the Bookmarks category owns it.
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

export interface ConfigSyncCategoryDescriptor {
  key: keyof ConfigSyncCategories;
  label: string;
  description: string;
  matches(rel: string): boolean;
}

// One list drives both the include decision and the settings UI toggles, so they cannot drift apart
// (docs/spec.md §7).
export const CONFIG_SYNC_CATEGORIES: readonly ConfigSyncCategoryDescriptor[] = [
  {
    key: 'bookmarks',
    label: 'Bookmarks',
    description: 'Obsidian bookmarks (bookmarks.json).',
    matches: (rel) => rel === 'bookmarks.json',
  },
  {
    key: 'others',
    label: 'Other settings (appearance, themes, hotkeys, core plugins)',
    description: 'Appearance & base settings (appearance.json, app.json), themes and CSS snippets (themes/, snippets/), hotkeys (hotkeys.json), and core-plugin settings (core-plugins.json, graph.json, etc.). A restart may be needed on the other device to apply core-plugin changes.',
    matches: (rel) =>
      rel === 'appearance.json' || rel === 'app.json'
      || rel.startsWith('themes/') || rel.startsWith('snippets/')
      || rel === 'hotkeys.json'
      || CORE_PLUGIN_CONFIG_FILES.includes(rel),
  },
];

export interface ConfigSyncResolverOptions {
  // Vault#configDir, e.g. `.obsidian` (user-relocatable).
  configDir: string;
  // Read on every call, so toggles take effect without a rebuild.
  settings: Pick<DavSyncSettings, 'syncConfigFolder' | 'configSync'>;
  // This plugin's own directory (sync-state DB, data.json): never synced. Already covered by the
  // `plugins/` rule, kept explicit as defense in depth.
  pluginDir: string;
  localAdapter: Pick<LocalAdapter, 'list' | 'stat'>;
}

// Single source of truth for which config-folder paths sync: `SyncEngine.isSystemExcluded`, the
// remote-file filter and the remote-deletion scope guard all consult `isIncluded`.
export class ConfigSyncResolver {
  constructor(private readonly opts: ConfigSyncResolverOptions) {}

  private rel(path: string): string | null {
    const cd = this.opts.configDir;
    if (path === cd) return '';
    const prefix = `${cd}/`;
    if (!path.startsWith(prefix)) return null;
    return path.slice(prefix.length);
  }

  isUnderConfigDir(path: string): boolean {
    return this.rel(path) !== null;
  }

  private isUnderPluginDir(path: string): boolean {
    const pd = this.opts.pluginDir;
    return path === pd || path.startsWith(`${pd}/`);
  }

  // Hard exclusions are evaluated before category matching, so no toggle combination can include
  // community-plugin code or the sync-state DB.
  isIncluded(path: string): boolean {
    const rel = this.rel(path);
    if (rel === null) return false;
    if (rel === '') return false;
    if (!this.opts.settings.syncConfigFolder) return false;
    if (this.isUnderPluginDir(path)) return false;
    if (rel === 'plugins' || rel.startsWith('plugins/')) return false;
    const cs = this.opts.settings.configSync;
    for (const cat of CONFIG_SYNC_CATEGORIES) {
      if (cs[cat.key] && cat.matches(rel)) return true;
    }
    return false;
  }

  isConfigFolderConflictPath(path: string): boolean {
    return this.isUnderConfigDir(path) && this.isIncluded(path);
  }

  // Never lists `plugins/`; every returned path satisfies `isIncluded`.
  async enumerateIncludedPaths(): Promise<string[]> {
    if (!this.opts.settings.syncConfigFolder) return [];
    const cd = this.opts.configDir;
    const cs = this.opts.settings.configSync;
    const out: string[] = [];

    const exactFiles: string[] = [];
    if (cs.bookmarks) exactFiles.push('bookmarks.json');
    if (cs.others) exactFiles.push('appearance.json', 'app.json', 'hotkeys.json', ...CORE_PLUGIN_CONFIG_FILES);
    for (const rel of exactFiles) {
      const p = `${cd}/${rel}`;
      const st = await this.opts.localAdapter.stat(p);
      if (st) out.push(p);
    }

    if (cs.others) {
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
      // Absent or unreadable directory: nothing to inject.
    }
  }
}
