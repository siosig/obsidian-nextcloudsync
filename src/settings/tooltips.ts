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
    'Only for manual sign-in — "Log in via browser" fills this for you. Must equal the <user> segment in the Server URL path: your Nextcloud user ID, usually not your email.',
  appPassword:
    'Only for manual sign-in — "Log in via browser" stores one for you, so you can skip this. Looks like xxxxx-xxxxx-xxxxx-xxxxx-xxxxx; required when 2FA is on (your normal password is rejected). After linking it there is no "login" action — once Server URL + Username + App password are all set you are signed in, and credentials are verified on the next sync.',
  loginViaBrowser:
    'Easiest path. Approve once in your browser and it fills Username and stores an App password for you, so you can skip the two manual fields. Polls up to ~3 min. Only the host part of Server URL is needed to start.',
  syncFolder:
    "Read-only. Fixed to this vault's name; the whole vault syncs under a remote folder of that name.",
  syncTarget:
    'Read-only preview of the effective remote path (Server URL + vault folder). Confirm this is where you expect the vault to sync.',
  // Sync section
  startupSyncDelay: 'Seconds to wait after startup before the startup sync. 0 = no startup sync.',
  syncInterval:
    'Auto-sync period. 0 = manual only. Disabled on mobile (the OS suspends background timers).',
  networkTimeout: 'Abort a WebDAV request that takes longer than this.',
  networkConcurrency:
    'How many WebDAV requests run at once. Higher = faster but more memory/connections. Mobile defaults lower.',
  syncOnWifiOnly:
    'Skip syncing on cellular (Wi-Fi/wired allowed). Unavailable on iOS (no network-type API).',
  syncOnFileChange:
    'Immediately sync a file or folder after you create, edit, delete, or rename it. Deletions and renames propagate too. Desktop only.',
  maxFileSize:
    'Skip files larger than this in both directions — uploads and downloads. 0 = unlimited. Keep low on mobile to avoid out-of-memory crashes.',

  // Conflict resolution section (feature 037)
  autoMergeFileTypes:
    'Comma-separated file extensions treated as Auto merge files (these use the Auto merge file strategy). Every other extension — and extensionless files — use the Other file strategy. Markdown is always special-cased (frontmatter + body handled separately) regardless of this list, so md is not listed here.',
  autoMergeFileStrategy:
    'Strategy for Auto merge files (and a markdown note’s body). Merge does a 3-way merge; a real conflict is then decided by the Conflict strategy below. The other four pick one side deterministically. Keep Nextcloud version history on so an overwritten side is recoverable.',
  otherFileStrategy:
    'Conflict strategy for every other file. Latest modified keeps the side with the newer modification time — beware: clock skew between devices can let an older edit overwrite a newer one with no prompt. Biggest size keeps the larger file; Local/Remote wins always keep that side. A size or mtime tie is left untouched and re-evaluated next sync.',

  // Conflict resolution — markdown frontmatter (feature 047) + conflict strategy (feature 048)
  frontmatterStrategy:
    'How a markdown note’s frontmatter block is resolved on conflict, INDEPENDENTLY of the body. Merge: array fields (tags, aliases, …) union-merge with deletion propagation; a scalar/object clash is decided by the Conflict strategy. Biggest size / Latest modified / Local wins / Remote wins each adopt one whole side’s frontmatter. Applies to every markdown note whatever the body strategy is. "Latest modified" uses file mtime — beware clock skew between devices.',
  conflictStrategy:
    'What happens when Merge cannot auto-resolve a part — a body line changed differently on both sides, or a clashing frontmatter field. Conflict markers keeps both versions in the file (frontmatter, which cannot hold markers, falls back to Latest modified). Biggest size / Latest modified / Local wins / Remote wins resolve each conflicting part deterministically. A deterministic body/frontmatter strategy never conflicts, so this is inert for it.',

  // Excluded folders section
  excludedFolders:
    'Folders listed here are never synced (folder-prefix match). Dotfolders like .git and the config plugins folder are already excluded by default.',
  addExcludedFolder:
    'Pick or type a vault-relative folder to exclude. The path is added to the list below.',

  // Config folder section
  syncConfigFolder:
    'Opt in to syncing parts of the Obsidian config folder across devices. Community plugins are never synced.',
  configBookmarks: 'Obsidian bookmarks (bookmarks.json).',
  configOthers:
    'Appearance & base settings, themes and CSS snippets, hotkeys, and core-plugin settings. Core-plugin changes may need a restart on the other device.',

  // Debug section
  loggingEnabled:
    'Write a single per-device log file (nextcloud-debug_<device>.txt) to the vault root while troubleshooting. Obsidian hides .txt unless "Detect all file extensions" is on; you can also open it via your OS or Nextcloud. Turn off and delete the file when done.',

  // Advanced (caution) section
  massDeleteLimit:
    'Safety cap on how many local files/folders one sync may delete when they disappear from the server — the guard against a partial/failed remote listing wiping your vault. -1 = automatic (recommended: max(20, 20% of tracked files)). 0 = no limit (risky). A positive number sets a fixed limit. Raise only if a real large deletion was blocked.',

  // Maintenance section
  resetVaultIndex:
    "Clears this device's sync index (first-install state). No files are deleted; the next sync re-scans.",
  mirrorFromRemote:
    'Overwrite this device to match the remote exactly: download everything the remote has and delete local files/folders it lacks (via your Obsidian trash setting, recoverable). A confirmation shows the counts first. Destructive.',
  lastSessionSummary:
    'Open the sync status dialog: recent runs, conflicts, retries and errors.',
} as const;

export type TooltipKey = keyof typeof TOOLTIPS;

/** Always-visible Server URL description (also readable on mobile, where tooltips don't show). */
export const SERVER_URL_DESC =
  'Full Nextcloud WebDAV endpoint: https://<host>/remote.php/dav/files/<user>/ (a trailing subfolder is allowed). Just the host (e.g. https://cloud.example.com) is not enough and fails with HTTP 405.';

/** Supplemental sign-in guidance shown at the top of the credentials area. */
export const SIGN_IN_HELP =
  'Two ways to sign in: (A) Log in via browser (recommended) fills Username and App password for you; or (B) enter Username + App password manually — they are alternatives, not both. There is no separate "login" button: once Server URL + Username + App password are set you are signed in and Sync now is enabled; credentials are verified on the next sync.';

/** Divider label between the recommended path and the manual fields. */
export const SIGN_IN_MANUAL_DIVIDER = '— or sign in manually —';

/** Config-folder category key → tooltip key. */
export const CONFIG_CATEGORY_TOOLTIP: Record<string, TooltipKey> = {
  bookmarks: 'configBookmarks',
  others: 'configOthers',
};
