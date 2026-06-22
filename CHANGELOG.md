# Changelog

All notable changes to **Nextcloud Sync for Obsidian** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Only stable releases (`x.y.z`) are listed. Pre-release `-beta.N` builds are
published as GitHub [Pre-releases](https://github.com/siosig/obsidian-nextcloudsync/releases)
and folded into the next stable entry.

> A Japanese translation is available at [`CHANGELOG.ja.md`](CHANGELOG.ja.md).

## [0.7.5] - 2026-06-23

- **Faster unchanged syncs on Nextcloud** — when the vault's remote contents have not changed since the last scan, the sync now skips the full remote directory listing and reuses cached state, detected via the root folder's ETag. Measured on a real server, an unchanged sync drops from two large directory listings to a single tiny request. Correctness is unaffected: any remote change is still picked up on the next sync, and the optimization only applies to Nextcloud (plain WebDAV is unchanged).
- **Security maintenance** — patched vulnerable build/test-only dependencies (no change to the shipped plugin).

## [0.7.4] - 2026-06-22

- **Dependency updates** — dev dependencies bumped to their latest versions: `@types/node` 25→26, `eslint` 10.4→10.5, `typescript-eslint` 8.60→8.61. No user-facing behaviour changes.

## [0.7.3] - 2026-06-21

- **Empty directories now sync correctly** — directories are treated as first-class entities alongside files. An empty folder created on one device now propagates to the remote and to every other device. A folder that is emptied and deleted on one device is now pruned from the remote and from every other device — fixing the long-standing bug where empty year folders like `2011/` lingered on the remote after all their files were deleted.

## [0.7.2] - 2026-06-21

- **Settings tooltips now appear anywhere on the row** — the hover tooltips added for every settings row previously attached only to the short bold title, so hovering the long description (where you actually read) showed nothing and the tooltips looked broken. They now label the whole row and appear on hover across it. The Server URL description still spells out the required full WebDAV endpoint (`https://<host>/remote.php/dav/files/<user>/`) so entering only a host no longer fails with an HTTP 405, and the sign-in area leads with "Log in via browser" with a clear divider before the manual Username/App password fields.
- **The conflict-region limit now applies to body text, not just frontmatter** — body merge conflicts are now counted with diff3, so exceeding your "max conflict regions" setting routes the file to your conflict-failure policy instead of always auto-merging. The default (`0` = unlimited) keeps the existing auto-merge behaviour.
- **Consistent 24-hour clock in the Sync Status dialog** — the last-session summary now shows `HH:mm` (date-prefixed across midnight), matching the per-entry rows, instead of a locale-dependent time.

## [0.7.1] - 2026-06-21

- **Fix: the plugin's own log files no longer error or churn during sync** — a per-device debug/sync log written *while* a sync runs raced its own write and reported "Destination file already exists!" every sync. The plugin now keeps a log file out of sync only while that log's output toggle is ON.
- **Frontmatter conflicts are now detected instead of silently merged** — a bug in the three-way merge made diverging YAML frontmatter merge silently even when conflict markers were requested. Conflicting frontmatter is now surfaced according to your conflict policy.
- **Reliable first upload into new folders on Nextcloud** — Nextcloud returns 404 (not the standard WebDAV 409) when a file's parent folder does not exist yet. The plugin now creates the missing folders and retries, so the first sync from a fresh device — or into a deep new path — no longer fails.
- **Fewer redundant server round-trips** — when a server does not support the incremental sync-collection report, the plugin now detects this once and goes straight to a full scan instead of retrying it on every sync.

## [0.7.0] - 2026-06-20

- **Faster mobile sync via Vault-cache enumeration** — local scanning now reads Obsidian's in-memory file index (`Vault.getFiles`) instead of making per-file native filesystem calls, removing the O(N) bridge round-trips that made sync slow on mobile. The initial scan also hashes only the files that actually need a checksum comparison, and network concurrency now scales with device memory uniformly across desktop and mobile (no platform-specific branch). Dot paths that `Vault.getFiles` omits are re-enumerated so they keep syncing.

## [0.6.1] - 2026-06-20

- **New "Reset vault index" maintenance action** — a new **Settings → Maintenance** section adds a button that clears this device's sync tracking index back to its first-install state (behind a confirmation), so the next sync re-scans everything from scratch. No Vault or remote files are deleted, and an in-progress sync is aborted first. The existing **Last session summary** entry now lives in this Maintenance section too.
- **First sync no longer shows a preview/approval step** — the initial-sync "dry run" confirmation modal has been removed; the first sync now scans and applies its plan directly. The reset action's confirmation is the deliberate point at which a full re-scan is acknowledged.

## [0.6.0] - 2026-06-20

- **Much faster sync — mobile/Android no longer stalls** — change detection now uses a stat signature recorded *as written* instead of relying on setting the modification time (a no-op on mobile), so a re-sync no longer re-reads and re-hashes the whole vault; the first sync no longer hashes the vault twice; transfers run with bounded parallelism capped by a memory-safe byte budget; file locking now defaults off with an `If-Match` optimistic-concurrency guard (fewer round trips, still no lost updates); and large server listings no longer freeze the UI.
- **Sync Status dialog reachable on mobile, grouped by sync run** — the settings **Last session summary** button opens the full Sync Status dialog on both desktop and mobile. Recent activity is grouped by sync run, each group headed by a separator showing that run's start time in 24-hour format, and your status-filter selection is remembered across restarts.

## [0.5.0] - 2026-06-20

- **Selective `.obsidian` config folder sync** — opt in via **Sync config folder** in settings to sync chosen categories of the Obsidian config folder across devices: Appearance, Themes & snippets, Hotkeys, Core plugin settings, and Bookmarks (each its own toggle, modelled on Obsidian native Sync). Off by default — notes still sync as before. **Community plugins (`.obsidian/plugins/`) and the plugin's own sync-state database are never synced** (executable code / device-specific state). Config files conflict-resolve by newest-wins so they are never corrupted with conflict markers. The previous standalone **Sync bookmarks** setting migrates automatically into the Bookmarks category, so existing bookmark-sync users keep working with no change. Resolves [#1](https://github.com/siosig/obsidian-nextcloudsync/issues/1).

## [0.4.1] - 2026-06-20

- **Log files are now created even when the log folder does not exist yet** — fixes a bug where, if the configured log folder (e.g. `_logs`) did not already exist, the per-device sync and debug logs were silently never written. The plugin now creates the parent folder before the first write.

## [0.4.0] - 2026-06-20

- **Filter the sync-status dialog by status** — the status dialog gained a checkbox row (Uploaded, Downloaded, Deleted, Merged, Conflicted, Local wins, Remote wins, Error) so you can focus on, say, only conflicts.
- **Compare a file with its remote version** — opt in via "Compare with remote (explorer menu)" in settings, then right-click any file in the explorer to open a popup comparing local vs remote modification time, checksum (with a match/mismatch badge), and a line diff. Resolve the difference there with **push** or **pull**, each behind a confirmation.
- **Files that differ between local and remote now always reconcile** — fixes a case where, on servers that return no content checksum (ETag fallback), a note could differ between this device and the server yet never sync; such a file is now detected and reconciled through normal conflict resolution.
- **Plain-text log files now use a .txt extension** — per-device sync and debug logs are plain text, so they use a `.txt` extension to avoid being rendered as Markdown. Existing `.md` log files are left untouched.
- **Internal refactor & documentation alignment** — brings the code in line with the official Obsidian developer guidelines: vault watchers and engine init are deferred to `onLayoutReady`, local paths are normalized at the IO boundary, modal titles use the native title bar, and the diff/error styling follows your theme's colors.

## [0.3.1] - 2026-06-19

- **Maintenance release (requires Obsidian 1.11.4+)** — no functional changes. Restores the community-directory listing by fixing an internal lint issue (an undescribed ESLint directive) that failed the 0.3.0 automated review, and re-enables the repository's git hooks so the pre-push gate mirrors the directory reviewer.

## [0.3.0] - 2026-06-19

- **Reorganized settings into four sections** — settings are grouped under **Nextcloud**, **Sync**, **Merge**, and **Debug** headings instead of one long flat list. "Max conflict regions" now shows its numeric value beside the slider and defaults to **0 = unlimited** (the region-count circuit-breaker no longer forces conflict markers by default).
- **Per-device logging** — two opt-in logs written to a folder you pick (a fuzzy folder picker; defaults to the vault root) and named per device so multiple devices never overwrite one another:
  - **Sync log** (`nextcloud-sync_sync_<device>.txt`) — one appended block per sync with the plugin version and all merge-related settings in the header, then one line per operation showing the marker, path, and local/remote checksums and sizes. A level switch records *important events only* (conflicts, merges, side-wins, errors) or *all operations*.
  - **Debug log** (`nextcloud-sync_debug_<device>.txt`) — a timestamped diagnostic log with selectable verbosity (error / debug / verbose), the plugin version, and a snapshot of all settings. Replaces the old single vault-root debug file; the legacy "Debug mode" toggle migrates automatically.
- **Stuck conflict count fixed** — a file that was once flagged as conflicted but has since converged (identical on both sides) now clears its flag on the next sync, so the conflict count no longer stays stuck at a non-zero number.
- **No telemetry** — the plugin collects no usage data, analytics, or crash reports; the only network traffic is the sync with your own server. Obsolete settings from earlier builds are also pruned from `data.json` on load.

## [0.2.10] - 2026-06-17

- **Clearer conflict reporting** — the sync-status dialog and summary now distinguish between two outcomes: **merged** (the file was auto-merged cleanly) and **conflicted** (conflict markers were left in the file). Previously both were lumped under a single "conflict" count, making it hard to tell whether action was needed.

## [0.2.9] - 2026-06-16

- **Passes Obsidian's automated store review** — inline styling moved to CSS classes and UI text to sentence case, clearing the Community-plugins automated checks that had delisted the entry.

## [0.2.8] - 2026-06-16

- **Installs on more setups** — the minimum required Obsidian version was corrected down to `1.11.4` (the true minimum the plugin needs), instead of effectively requiring only the very latest release.

## [0.2.7] - 2026-06-16

- **Manual "Sync now" button and live 24-hour activity** — the sync-status dialog gained a **Sync now** button at the top, a scrollable **last-24h activity history** (one compact, icon-led line per file), and now applies a changed auto-sync interval immediately without needing a reload.

## [0.2.6] - 2026-06-11

- **Watch-mode self-feedback loop fixed** — the plugin's own writes (downloads, merged conflicts) are no longer re-detected as user edits, eliminating spurious re-uploads, error storms, and unintended remote deletes when "Sync on file change" is enabled.
- **One failing file no longer aborts the sync** — a per-file error (e.g. a server-side 403) is recorded and the rest of the session continues; network errors are still queued for retry with backoff.
- **Error details in the sync-status dialog** — clicking the status bar now also shows an "Errors in last sync" list (one row per failed file, clickable to open it) instead of only an opaque error count.
- **State database saves are serialized** — concurrent watch-mode syncs can no longer race each other into a corrupted or missing sync-state file.

## [0.2.5] - 2026-06-11

- **Remote-deletion scope guard (security hardening)** — server-reported deletions are validated against the sync scope before being applied, so a malicious or compromised server can no longer make the client delete files outside the synced folder (e.g. under `.obsidian/`).

## [0.2.4] - 2026-06-10

- **Sturdier downloads** — the parent folder is created before each atomic write, and per-file non-network errors no longer stop the remaining files from syncing.

## [0.2.2] - 2026-06-09

- **Conflict-resolution policy** — choose what happens when a conflict can't be cleanly auto-merged: leave both sides untouched and retry (**Error**, the default), keep **Local**, keep **Remote**, or embed **conflict markers**. Configurable in settings.
- **Merge limited to text files** — only configurable extensions (default `md`, `txt`) are ever text-merged. Other files (images, PDFs, binaries) are never merged, so conflict markers can no longer corrupt them. The default conflict outcome changed from embedding `<<<<<<<` markers to **Error** (skip and retry on the next sync).

## [0.2.0] - 2026-06-09

Initial public releases (0.2.0 – 0.2.1) of the Nextcloud-specific sync engine:

- **Reliable cross-device deletions** — deleting a file on one device now propagates correctly instead of the file reappearing on the next sync (sync-token handling fixed, with content-verified, recoverable deletions and a mass-deletion safety guard).
- **Auto-merged conflicts now reach the server** — a merged conflict is uploaded so all devices converge, instead of the same conflict re-appearing every sync.
- **Mobile diagnostics** — the debug log writes a per-device `nextcloud-sync_debug_<device>.txt` on mobile too, and "Sync now" shows a result notice.
- **Mobile (iOS / Android) support** — the plugin now runs on mobile, with platform-aware behavior so desktop is unchanged.
- **Clickable status bar → sync-status dialog** — click the status bar item to open a dialog summarizing the current sync state, the last sync, any unresolved conflicts, and (since 0.2.6) any per-file errors from the last sync.
- **"Sync now" promoted to the top of settings** and gated on authentication, so you can trigger a sync the moment you're signed in.
- **Platform-aware default settings** — defaults are tuned per platform (e.g. network concurrency, sync-on-startup, maximum file size).
- **YAML frontmatter is now auto-merged** — non-overlapping frontmatter edits merge cleanly (via diff3), falling back to conflict markers only when both sides change the same lines.
- **Clearer conflict outcomes in the dry-run** — the first-sync preview now explains what conflict resolution will produce, and each conflicted file is clickable to preview the exact merged before/after result.
- **Faster than generic WebDAV** — by diffing content hashes against Nextcloud's `sync-token`, each sync transfers only what actually changed instead of recursively walking the entire remote tree on every run, so syncs complete noticeably faster than modification-time-based WebDAV plugins.

[0.7.5]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.5
[0.7.4]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.4
[0.7.3]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.3
[0.7.2]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.2
[0.7.1]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.1
[0.7.0]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.0
[0.6.1]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.6.1
[0.6.0]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.6.0
[0.5.0]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.5.0
[0.4.1]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.4.1
[0.4.0]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.4.0
[0.3.1]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.3.1
[0.3.0]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.3.0
[0.2.10]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.2.10
[0.2.9]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.2.9
[0.2.8]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.2.8
[0.2.7]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.2.7
[0.2.6]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.2.6
[0.2.5]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.2.5
[0.2.4]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.2.4
[0.2.2]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.2.2
[0.2.0]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.2.0
