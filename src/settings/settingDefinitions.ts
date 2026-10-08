import type { Setting, SettingDefinitionItem, SettingDefinitionGroup, SettingGroupItem, TFolder } from 'obsidian';
import type { DavSyncSettings } from '../types';
import { CONFIG_SYNC_CATEGORIES } from '../sync/ConfigSyncResolver';
import { SLIDER_LIMITS } from './sliderLimits';
import { SERVER_URL_DESC, SIGN_IN_HELP, SIGN_IN_MANUAL_DIVIDER } from './settingsCopy';
import { isSupportedNextcloudVersion } from '../util/version';

// The settings tab as data: Obsidian 1.13.0 builds its settings search index only from `getSettingDefinitions()`
// (obsidian.d.ts:6570-6586), so an imperative display() would be invisible to search.
// Kept apart from SettingTab: pure data plus predicates over a host interface, so layer a can run the key-integrity check
// in settingDefinitions.test.ts with a plain fake. A mistyped `key` renders a working-looking row that persists nothing.
//
// `control` rows carry a `key` and are bound by Obsidian to the plugin's storage (preferred). `render` rows hand back a
// real `Setting` (obsidian.d.ts:6284) and carry no key, so the integrity check cannot cover them.
// Go declarative unless something is lost: tooltips moved into `desc` (mobile can read it), but the numeric input beside
// each slider has no declarative equivalent, so those five rows stay `render`.

// isMobile / isIosApp are passed IN rather than read from `Platform`, so layer a can assert both sides of every platform predicate.
export interface SettingDefinitionsHost {
  // Predicates read it on every render, so it must not be copied.
  settings: DavSyncSettings;
  isMobile: boolean;
  isIosApp: boolean;
  isSignedIn: boolean;
  // The config-folder heading is built from Vault#configDir, never hardcoded.
  configDir: string;
  vaultName: string;
  syncTargetUrl(): string;

  runSyncNow(): unknown;
  runRemoteMirror(): unknown;
  resetVaultIndex(): unknown;
  openSyncStatus(): unknown;
  startLoginFlow(): unknown;
  addExcludedFolder(path: string): unknown;
  removeExcludedFolder(path: string): unknown;

  renderAppPassword(setting: Setting): unknown;
  renderNumberSlider(setting: Setting, opts: NumberSliderOptions): unknown;
  renderReadOnly(setting: Setting, value: string, cls?: string): unknown;
  renderNotice(setting: Setting, text: string, cls?: string): unknown;
  renderExtensionList(setting: Setting): unknown;
  renderAddExcludedFolder(setting: Setting): unknown;
}

export interface NumberSliderOptions {
  min: number;
  max: number;
  step: number;
  get(): number;
  set(value: number): void;
  apply?: () => void | Promise<void>;
}

// Settings that intentionally have no row. Explicit so the "every setting reaches the UI" check cannot silently skip a dropped row.
export const UI_LESS_SETTING_KEYS: readonly (keyof DavSyncSettings)[] = [
  'deviceId',            // generated once; identifies this device in logs
  'deviceName',          // derived from platform + deviceId
  'logsFolder',          // fixed to the vault root
  'statusFilter',        // persisted UI state of the Sync Status dialog, not a preference
  'lastKnownServerVersion', // observed from the server, for the version-recommendation banner
  'configSync',          // container object; its categories bind through their own rows
];

export const RENDER_ONLY_ROWS = {
  authBanner: 'Not signed in yet',
  decorations: [
    'Not signed in yet',
    'Server compatibility',
    'Per-vault settings',
    'Sign-in help',
    'Manual sign-in',
    'Advanced warning',
  ] as string[],
  // Settings whose row is a `render` row, out of the key-integrity check's reach; listed so the reverse-direction check does not report them as missing.
  settingKeys: [
    'passwordSecretId',        // SecretComponent — no declarative secret control exists
    'startupSyncDelaySeconds', // slider + numeric input
    'syncIntervalMinutes',
    'networkTimeoutSeconds',
    'networkConcurrency',
    'maxFileSizeMB',
    'excludedFolders',         // list plus an add row with its own folder picker
    'autoMergeFileTypes',      // string[] shown comma-joined; needs a parse/format round-trip
  ] as (keyof DavSyncSettings)[],
} as const;

const CONFLICT_STRATEGY_OPTIONS = {
  'biggest-size': 'Biggest size',
  'latest-mtime': 'Latest modified',
  'local-win': 'Local wins',
  'remote-win': 'Remote wins',
} as const;

// Called on every render (obsidian.d.ts:6577-6583), so the row set is dynamic: one row per excluded folder, and two
// config-category rows only while the master toggle is on. The count is 27 + excludedFolders.length + (syncConfigFolder ? 2 : 0).
export function buildSettingDefinitions(host: SettingDefinitionsHost): SettingDefinitionItem[] {
  return [
    topGroup(host),
    nextcloudGroup(host),
    syncGroup(host),
    conflictGroup(host),
    excludedFoldersGroup(host),
    configFolderGroup(host),
    debugGroup(host),
    advancedGroup(host),
    maintenanceGroup(host),
  ];
}

const group = (heading: string | undefined, items: SettingGroupItem[]): SettingDefinitionGroup => ({
  type: 'group',
  ...(heading ? { heading } : {}),
  items,
});

function notice(
  host: SettingDefinitionsHost,
  name: string,
  text: string,
  opts: { cls?: string; visible?: () => boolean } = {},
): SettingGroupItem {
  return {
    name,
    desc: text,
    searchable: false,
    ...(opts.visible ? { visible: opts.visible } : {}),
    render: (setting: Setting) => host.renderNotice(setting, text, opts.cls),
  } as SettingGroupItem;
}

function slider(
  host: SettingDefinitionsHost,
  name: string,
  desc: string,
  aliases: string[],
  limit: { min: number; max: number; step: number },
  get: () => number,
  set: (v: number) => void,
  apply?: () => void | Promise<void>,
): SettingGroupItem {
  return {
    name,
    desc,
    aliases,
    render: (setting: Setting) =>
      host.renderNumberSlider(setting, { ...limit, get, set, ...(apply ? { apply } : {}) }),
  } as SettingGroupItem;
}


function topGroup(host: SettingDefinitionsHost): SettingDefinitionGroup {
  const s = host.settings;
  const items: SettingGroupItem[] = [
    notice(
      host,
      RENDER_ONLY_ROWS.authBanner,
      'Enter the server URL below, then log in (or fill in a username and app password). Syncing stays disabled until you do.',
      { cls: 'ncs-auth-warning', visible: () => !host.isSignedIn },
    ),
    {
      name: 'Sync now',
      // The enabling condition lives in the description because mobile users cannot see hover tooltips.
      desc: 'Sync this vault with Nextcloud now. Enabled once Server URL, username and app password are set.',
      aliases: ['sync', 'run', 'manual sync', 'push', 'pull'],
      disabled: () => !host.isSignedIn,
      action: () => { void host.runSyncNow(); },
    },
  ];
  if (s.lastKnownServerVersion) {
    // Narrowed to a local so the `visible` closure below keeps the non-undefined type: TS does not
    // carry the `if` narrowing of `s.lastKnownServerVersion` into a function literal.
    const lastKnownServerVersion = s.lastKnownServerVersion;
    // Kept as a decoration: it reports an observation, not a preference.
    items.splice(1, 0, notice(host, 'Server compatibility', serverVersionNotice(lastKnownServerVersion), {
      cls: 'ncs-setting-warning',
      visible: () => !isSupportedNextcloudVersion(lastKnownServerVersion),
    }));
  }
  items.splice(items.length - 1, 0, notice(
    host,
    'Per-vault settings',
    'Settings are stored per-vault. Each vault can have a different Nextcloud server and user.',
  ));
  return group(undefined, items);
}

function serverVersionNotice(version: string): string {
  return `Connected Nextcloud server is ${version}. A newer server is recommended; some features may be unavailable or degrade on older servers.`;
}


function nextcloudGroup(host: SettingDefinitionsHost): SettingDefinitionGroup {
  return group('Nextcloud', [
    {
      name: 'Server URL',
      desc: `${SERVER_URL_DESC} You may append a subfolder (e.g. .../<user>/Documents) to sync there.`,
      aliases: ['endpoint', 'webdav', 'host', 'address', 'url'],
      control: { type: 'text', key: 'serverUrl', placeholder: 'https://cloud.example.com/remote.php/dav/files/alice/' },
    },
    notice(host, 'Sign-in help', SIGN_IN_HELP),
    {
      name: 'Log in via browser (Nextcloud) — recommended',
      desc: 'Easiest path: approve once in your browser and it fills Username and stores an App password for you, so you can skip the two manual fields. Requires the server URL above (only its host part). Polls up to ~3 minutes. Falls back to manual entry on non-Nextcloud servers.',
      aliases: ['login', 'sign in', 'oauth', 'browser', 'authorize'],
      disabled: () => host.settings.serverUrl.trim().length === 0,
      action: () => { void host.startLoginFlow(); },
    },
    notice(host, 'Manual sign-in', SIGN_IN_MANUAL_DIVIDER, { cls: 'ncs-signin-divider' }),
    {
      name: 'Username',
      desc: 'Nextcloud username (vault-specific). Only needed for manual sign-in — "Log in via browser" fills this for you. Must equal the <user> segment in the Server URL path: your Nextcloud user ID, usually not your email.',
      aliases: ['user', 'account', 'login name', 'uid'],
      control: { type: 'text', key: 'username' },
    },
    {
      // render: the app password lives in Obsidian's encrypted Secret Storage via SecretComponent,
      // and the declarative control set has no secret type (obsidian.d.ts:5878).
      name: 'App password',
      desc: 'Nextcloud app password (only for manual sign-in). Click "Link…" to store it in Obsidian\'s encrypted Secret Storage — it is never saved in data.json. Generate one at Settings → Security → Devices & Sessions. It looks like xxxxx-xxxxx-xxxxx-xxxxx-xxxxx and is required when 2FA is on, since your normal password is rejected. There is no separate "login" action: once Server URL, Username and App password are set you are signed in, and the credentials are verified on the next sync.',
      aliases: ['token', 'credential', 'api key', 'password', 'secret'],
      render: (setting: Setting) => host.renderAppPassword(setting),
    } as SettingGroupItem,
    {
      name: 'Sync folder',
      desc: "Read-only. Fixed to this vault's name; the whole vault syncs under a remote folder of that name.",
      aliases: ['remote folder', 'destination', 'target folder'],
      render: (setting: Setting) => host.renderReadOnly(setting, host.vaultName),
    } as SettingGroupItem,
    {
      name: 'Sync target (WebDAV)',
      desc: 'Read-only preview of the effective remote path (Server URL + vault folder). Confirm this is where you expect the vault to sync.',
      aliases: ['effective url', 'remote path', 'destination'],
      render: (setting: Setting) => host.renderReadOnly(setting, host.syncTargetUrl(), 'ncs-break-all'),
    } as SettingGroupItem,
  ]);
}


function syncGroup(host: SettingDefinitionsHost): SettingDefinitionGroup {
  const s = host.settings;
  return group('Sync', [
    slider(
      host,
      'Startup sync delay (seconds)',
      'Wait this many seconds after startup before the startup sync. 0 = no startup sync.',
      ['launch', 'boot', 'startup sync', 'open'],
      SLIDER_LIMITS.startupSyncDelay,
      () => s.startupSyncDelaySeconds,
      (v) => { s.startupSyncDelaySeconds = v; },
    ),
    slider(
      host,
      'Sync interval (minutes)',
      host.isMobile
        ? 'Disabled on mobile (the OS suspends background timers). Use "Startup sync delay" or "Sync now".'
        : 'Auto-sync period. 0 = manual sync only.',
      ['periodic', 'schedule', 'auto sync', 'every', 'timer'],
      SLIDER_LIMITS.syncInterval,
      () => s.syncIntervalMinutes,
      (v) => { s.syncIntervalMinutes = v; },
    ),
    slider(
      host,
      'Network timeout (seconds)',
      'Abort a WebDAV request that takes longer than this.',
      ['timeout', 'slow', 'hang', 'abort'],
      SLIDER_LIMITS.networkTimeout,
      () => s.networkTimeoutSeconds,
      (v) => { s.networkTimeoutSeconds = v; },
    ),
    slider(
      host,
      'Network concurrency',
      'How many WebDAV requests run at once. Higher is faster but uses more memory and connections. Mobile defaults to a lower value.',
      ['parallel', 'simultaneous', 'threads', 'speed'],
      SLIDER_LIMITS.networkConcurrency,
      () => s.networkConcurrency,
      (v) => { s.networkConcurrency = v; },
    ),
    {
      name: 'Sync on Wi-Fi only',
      desc: host.isIosApp
        ? 'Not available on iOS (no network-type API). The app cannot tell Wi-Fi from cellular here.'
        : 'Skip syncing while on a cellular connection (Wi-Fi and wired are allowed).',
      aliases: ['cellular', 'mobile data', 'metered', 'data usage'],
      control: { type: 'toggle', key: 'syncOnWifiOnly', disabled: () => host.isIosApp },
    },
    {
      name: 'Sync on file change',
      desc: 'Immediately sync a file or folder right after you create, edit, delete, or rename it (a short delay after you stop editing). Deletions and renames propagate too. Works alongside the periodic sync interval. On mobile it runs only while Obsidian is open; anything it misses is sent on the next sync. Paused on cellular when "Sync on Wi-Fi only" is on.',
      aliases: ['watch', 'auto sync', 'realtime', 'live', 'on save'],
      control: { type: 'toggle', key: 'watchOnChangeEnabled' },
    },
    slider(
      host,
      'Maximum file size (MB)',
      'Files larger than this are skipped with a warning, in both directions (upload and download). 0 = unlimited. On mobile a low limit avoids out-of-memory crashes.',
      ['size limit', 'large files', 'skip', 'attachment'],
      SLIDER_LIMITS.maxFileSize,
      () => s.maxFileSizeMB,
      (v) => { s.maxFileSizeMB = v; },
    ),
  ]);
}


function conflictGroup(host: SettingDefinitionsHost): SettingDefinitionGroup {
  return group('Conflict resolution', [
    {
      // render: the stored value is a string[], and the field shows it comma-joined. A `text`
      // control binds a string straight through, with nowhere to put the parse/format pair.
      name: 'Auto merge file types',
      desc: 'Comma-separated file extensions treated as "auto merge files", such as txt or py. These use the auto merge file strategy below; every other file — and extensionless files — use the other file strategy. Clear the field to route every file through the other file strategy. Markdown is always special-cased (frontmatter and body handled separately) regardless of this list, so md is not listed here.',
      aliases: ['extensions', 'mergeable', 'text files', 'filetypes'],
      render: (setting: Setting) => host.renderExtensionList(setting),
    } as SettingGroupItem,
    {
      name: 'Auto merge file strategy',
      desc: 'How to resolve a conflict on an auto merge file, and on a Markdown note\'s body. Merge attempts a 3-way merge (clean → merged, text conflict → decided by the conflict strategy below, non-text → held untouched); the others pick one side deterministically. Keep Nextcloud version history on so an overwritten side stays recoverable.',
      aliases: ['merge', 'three-way', 'body strategy'],
      control: {
        type: 'dropdown',
        key: 'autoMergeFileStrategy',
        options: { merge: 'Merge', ...CONFLICT_STRATEGY_OPTIONS },
      },
    },
    {
      name: 'Other file strategy',
      desc: 'How to resolve a conflict on every other file (images, PDFs, config JSON, …). Latest modified keeps the side with the newer modification time — beware that clock skew between devices can let an older edit overwrite a newer one with no prompt. Biggest size keeps the larger file; Local/Remote wins always keep that side. A size or mtime tie is left untouched and re-evaluated next sync.',
      aliases: ['binary', 'images', 'attachments', 'non-text'],
      control: { type: 'dropdown', key: 'otherFileStrategy', options: { ...CONFLICT_STRATEGY_OPTIONS } },
    },
    {
      name: 'Frontmatter strategy',
      desc: 'How a Markdown note\'s frontmatter block is resolved on conflict, independently of the body. Merge does a semantic merge: array fields such as tags and aliases union-merge with deletion propagation, and a scalar or object clash is decided by the conflict strategy below. The other four adopt one whole side\'s frontmatter block. Applies to every Markdown note whatever the body strategy is. "Latest modified" uses file mtime — beware clock skew between devices.',
      aliases: ['yaml', 'metadata', 'tags', 'properties'],
      control: {
        type: 'dropdown',
        key: 'frontmatterStrategy',
        options: { merge: 'Merge', ...CONFLICT_STRATEGY_OPTIONS },
      },
    },
    {
      name: 'Conflict strategy',
      desc: 'What happens when merge cannot auto-resolve a part — a body line both sides changed, or a clashing frontmatter field. Conflict markers keeps both versions in the file (frontmatter, which cannot hold markers, falls back to latest modified); the others resolve each conflicting part deterministically. A deterministic body or frontmatter strategy never conflicts, so this is inert for it.',
      aliases: ['markers', 'unresolved', 'both sides'],
      control: {
        type: 'dropdown',
        key: 'conflictStrategy',
        options: { 'conflict-markers': 'Conflict markers', ...CONFLICT_STRATEGY_OPTIONS },
      },
    },
  ]);
}


function excludedFoldersGroup(host: SettingDefinitionsHost): SettingDefinitionGroup {
  const excluded = host.settings.excludedFolders ?? [];
  const items: SettingGroupItem[] = [
    {
      name: 'Excluded folders',
      desc: 'Folders that are never synced — neither uploaded nor downloaded. Matched by folder prefix at a folder boundary, additive on top of .git, .trash, the config plugins folder, and plugin state, which are already excluded automatically.',
      aliases: ['ignore', 'exclude', 'skip', 'blacklist', 'git'],
      render: (setting: Setting) =>
        host.renderReadOnly(setting, excluded.length ? `${excluded.length} excluded` : 'None'),
    } as SettingGroupItem,
  ];
  // One row per excluded folder. Dynamic by design: getSettingDefinitions() runs on every render.
  for (const folder of excluded) {
    items.push({
      name: folder,
      desc: 'Excluded from syncing.',
      searchable: false,
      action: () => { void host.removeExcludedFolder(folder); },
    });
  }
  items.push({
    // render: a `folder` control persists one path into one key; this row appends to a list and
    // then clears itself, which no single-value binding expresses.
    name: 'Add excluded folder',
    desc: 'Choose a vault folder to stop syncing. Start typing to pick from matching folders. The path is added to the list above.',
    aliases: ['ignore', 'exclude', 'skip', 'add folder'],
    render: (setting: Setting) => host.renderAddExcludedFolder(setting),
  } as SettingGroupItem);
  return group('Excluded folders', items);
}


function configFolderGroup(host: SettingDefinitionsHost): SettingDefinitionGroup {
  const items: SettingGroupItem[] = [
    {
      name: 'Sync config folder',
      desc: `Opt in to syncing parts of the ${host.configDir} config folder across devices. Off by default — only notes and other vault files sync. Community plugins are never synced; their files stay device-local. A synced change to core-plugin settings may need an Obsidian restart to take effect on the other device.`,
      aliases: ['obsidian folder', 'appearance', 'themes', 'hotkeys', 'settings sync'],
      control: { type: 'toggle', key: 'syncConfigFolder' },
    },
  ];
  // Category rows exist only while the master toggle is on — the second source of dynamic rows.
  if (host.settings.syncConfigFolder) {
    for (const category of CONFIG_SYNC_CATEGORIES) {
      items.push({
        name: category.label,
        desc: category.description,
        // Dotted key: the value lives at settings.configSync.<category>, and spelling the path out
        // keeps the storage location visible in the definition instead of hidden in a setter.
        control: { type: 'toggle', key: `configSync.${category.key}` },
      });
    }
  }
  return group(`Config folder (${host.configDir})`, items);
}


function debugGroup(host: SettingDefinitionsHost): SettingDefinitionGroup {
  return group('Debug', [
    {
      name: 'Enable logging (troubleshooting)',
      desc: 'Write a single per-device log file (nextcloud-debug_<device>.txt) to the vault root while troubleshooting. The device name is derived automatically and the location is fixed to the vault root. Obsidian hides .txt unless Settings → Files & Links → "Detect all file extensions" is on; you can also open it via your OS or Nextcloud. Turn this off and delete the file when finished.',
      aliases: ['debug', 'log', 'diagnostics', 'verbose', 'troubleshoot'],
      control: { type: 'toggle', key: 'loggingEnabled' },
    },
  ]);
}

function advancedGroup(host: SettingDefinitionsHost): SettingDefinitionGroup {
  return group('Advanced (use with caution)', [
    notice(
      host,
      'Advanced warning',
      'Caution: these options can cause data loss. Change them only if you understand the risk.',
      { cls: 'ncs-setting-warning' },
    ),
    {
      name: 'Mass-delete safety limit',
      desc: 'Most files and folders one sync may delete locally when they vanish from the server — the guard that stops a partial or failed remote listing from wiping your vault. -1 = automatic (recommended): the built-in limit of max(20, 20% of tracked files). 0 = no limit (risky — a broken listing could delete everything locally). A positive number sets a fixed limit. Raise this only if a legitimate large deletion was blocked.',
      aliases: ['breaker', 'bulk delete', 'safety', 'protection', 'guard'],
      control: { type: 'number', key: 'massDeleteLimit', placeholder: '-1', min: -1, max: 1_000_000, step: 1 },
    },
  ]);
}

function maintenanceGroup(host: SettingDefinitionsHost): SettingDefinitionGroup {
  return group('Maintenance', [
    {
      name: 'Reset vault index',
      desc: "Clear this device's sync tracking index so the plugin returns to its first-install state. No vault or remote files are deleted; the next sync performs a full re-scan. Use this if the sync state looks inconsistent.",
      aliases: ['reindex', 'rescan', 'clear state', 'troubleshoot', 'repair'],
      action: () => { void host.resetVaultIndex(); },
    },
    {
      name: 'Mirror from remote',
      desc: 'Force this device\'s vault to exactly match the remote: download everything the remote has, and delete local files and folders that are not on the remote, honoring your Obsidian "deleted files" setting so removals stay recoverable. Unsynced local changes are discarded. A confirmation shows how many files will be downloaded and deleted before anything happens. Use this to make a device follow the remote after migrating from another sync tool.',
      aliases: ['overwrite', 'reset local', 'force download', 'pull', 'migrate'],
      action: () => { void host.runRemoteMirror(); },
    },
    {
      name: 'Last session summary',
      desc: 'Open the sync status dialog: recent activity grouped by sync run, conflicts, retries, and errors.',
      aliases: ['status', 'history', 'errors', 'report', 'log'],
      action: () => { void host.openSyncStatus(); },
    },
  ]);
}

export function excludableFolderFilter(host: SettingDefinitionsHost): (folder: TFolder) => boolean {
  return (folder: TFolder) => !(host.settings.excludedFolders ?? []).includes(folder.path);
}
