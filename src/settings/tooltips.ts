// Settings tooltips (hover help) for the settings tab. UI strings are English.
// This module is the source of truth for the tooltip wording. Each entry adds
// information beyond the always-visible description (defaults, ranges, units,
// examples, common mistakes). Tooltips only show on hover (desktop); information
// essential on mobile (e.g. the Server URL format) is also kept in setDesc.
//
// Exhaustively covered by tests/a-no-nextcloud/ui/settingsTooltips.test.ts: every
// non-heading settings row must have an entry here.

export const TOOLTIPS = {
  // Top action
  syncNow:
    'Sync this vault with Nextcloud now. Enabled once Server URL, username and app password are set.',

  // Nextcloud section
  serverUrl:
    'Full WebDAV endpoint, not just the host. Format: https://<host>/remote.php/dav/files/<user>/. You may append a subfolder (e.g. .../<user>/Documents) to sync there. Entering only https://<host> fails with HTTP 405.',
  username:
    'Only for manual sign-in — “Log in via browser” fills this for you. Must equal the <user> segment in the Server URL path: your Nextcloud user ID, usually not your email.',
  appPassword:
    'Only for manual sign-in — “Log in via browser” stores one for you, so you can skip this. Looks like xxxxx-xxxxx-xxxxx-xxxxx-xxxxx; required when 2FA is on (your normal password is rejected). After linking it there is no “login” action — once Server URL + Username + App password are all set you are signed in, and credentials are verified on the next sync.',
  loginViaBrowser:
    'Easiest path. Approve once in your browser and it fills Username and stores an App password for you, so you can skip the two manual fields. Polls up to ~3 min. Only the host part of Server URL is needed to start.',
  syncFolder:
    'Read-only. Fixed to this vault’s name; the whole vault syncs under a remote folder of that name.',
  syncTarget:
    'Read-only preview of the effective remote path (Server URL + vault folder). Confirm this is where you expect the vault to sync.',

  // Sync section
  syncInterval:
    'Auto-sync period. 0 = manual only. Disabled on mobile (the OS suspends background timers).',
  syncOnWifiOnly:
    'Skip syncing on cellular (Wi-Fi/wired allowed). Unavailable on iOS (no network-type API).',

  // Config folder section
  syncConfigFolder:
    'Opt in to syncing parts of the Obsidian config folder across devices. Community plugins are never synced.',
  configBookmarks: 'Obsidian bookmarks (bookmarks.json).',
  configOthers:
    'Appearance & base settings, themes and CSS snippets, hotkeys, and core-plugin settings. Core-plugin changes may need a restart on the other device.',

  // Excluded folders section
  excludedFolders:
    'Folders listed here are never synced (folder-prefix match). Dotfolders like .git and the config plugins folder are already excluded by default.',
  addExcludedFolder:
    'Pick or type a vault-relative folder to exclude. Browse… opens a folder picker; the path is added to the list below.',

  // Maintenance section
  loggingEnabled:
    'Write a per-device sync log (all operations) and a verbose debug log to the vault root while troubleshooting. Turn off and delete the log files when done.',
  resetVaultIndex:
    'Clears this device’s sync index (first-install state). No files are deleted; the next sync re-scans.',
  lastSessionSummary:
    'Open the sync status dialog: recent runs, conflicts, retries and errors.',
} as const;

export type TooltipKey = keyof typeof TOOLTIPS;

/** Always-visible Server URL description (also readable on mobile, where tooltips don't show). */
export const SERVER_URL_DESC =
  'Full Nextcloud WebDAV endpoint: https://<host>/remote.php/dav/files/<user>/ (a trailing subfolder is allowed). Just the host (e.g. https://cloud.example.com) is not enough and fails with HTTP 405.';

/** Supplemental sign-in guidance shown at the top of the credentials area. */
export const SIGN_IN_HELP =
  'Two ways to sign in: (A) Log in via browser (recommended) fills Username and App password for you; or (B) enter Username + App password manually — they are alternatives, not both. There is no separate “login” button: once Server URL + Username + App password are set you are signed in and Sync now is enabled; credentials are verified on the next sync.';

/** Divider label between the recommended path and the manual fields. */
export const SIGN_IN_MANUAL_DIVIDER = '— or sign in manually —';

/** Config-folder category key → tooltip key. */
export const CONFIG_CATEGORY_TOOLTIP: Record<string, TooltipKey> = {
  bookmarks: 'configBookmarks',
  others: 'configOthers',
};
