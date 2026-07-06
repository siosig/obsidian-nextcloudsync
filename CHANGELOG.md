# Changelog

All notable changes to **Nextcloud Sync for Obsidian** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Only stable releases (`x.y.z`) are listed. Pre-release `-beta.N` builds are
published as GitHub [Pre-releases](https://github.com/siosig/obsidian-nextcloudsync/releases)
and folded into the next stable entry.

> A Japanese translation is available at [`CHANGELOG.ja.md`](CHANGELOG.ja.md).

## [0.7.25] - 2026-07-06

### Fixed
- Fixed a permanently stuck sync caused by client-side caching: a file could keep failing to sync forever (even across restarts and manual "Sync now" / "Use remote" attempts) if the app's own network cache had ever stored a bad, incomplete response for it. Every request now explicitly disables that caching, so a bad response is never replayed and the next sync always reaches the server for a fresh answer.

### Changed
- Troubleshooting logging is redesigned into one findable file: enabling **Debug → Enable logging** now writes a single per-device file, `nextcloud-debug_<device>.txt`, at the vault root (the old two separate log files are merged). Turning it on immediately shows a notice naming the exact file and reminding you that Obsidian hides `.txt` unless **Settings → Files & Links → Detect all file extensions** is on (you can also open it via your OS or Nextcloud). A failed log write now surfaces a notice instead of being silent.

## [0.7.24] - 2026-07-05

### Added
- Frontmatter now has its own conflict strategy, independent of the body: a `.md` file's frontmatter block and body are resolved separately, with a new **Frontmatter strategy** setting (default: merge) covering the frontmatter and the existing file-type merge strategy still covering the body.
- Two-level conflict resolution: when the primary strategy (frontmatter / auto-merge / other-file) can't fully resolve a clash, the remaining conflicting region or field falls back to a second, explicit **Conflict strategy** (default: conflict markers) instead of an all-or-nothing decision.
- **Mirror from remote** now opens a progress dialog immediately and shows live progress through every stage (reading the remote, comparing, then downloading/deleting) instead of appearing frozen.
- The mass-delete safety limit is now configurable under a new **Advanced (use with caution)** section: `-1` = automatic (the safe default), `0` = no limit, or a fixed number.

## [0.7.23] - 2026-07-04

### Fixed
- The **Sync interval** slider now reads honestly on mobile. Periodic auto-sync never runs on mobile (the OS suspends background timers), yet the slider still showed the desktop default of 15 minutes while greyed out, as if a timed sync were active. On a fresh mobile install the interval now defaults to 0 (manual only), so the disabled slider matches actual behavior. Desktop is unchanged, and any interval already set is preserved.

## [0.7.22] - 2026-07-04

### Added
- Folder changes now propagate instantly in watch mode. With **Sync on file change** on, creating, deleting, or renaming a folder is pushed to the server right away (create → the folder is made, delete → moved to the trash, rename → moved), matching the behavior files already had. The status bar shows when a change is being pushed, and the setting description now correctly states that it covers files *and* folders across create/edit/delete/rename (desktop only).
- New **Mirror from remote** maintenance action under **Settings → Maintenance** that forces this device's vault to exactly match the remote: it downloads everything the remote has and moves local files and folders the remote no longer has to the Obsidian trash (recoverable). A confirmation first shows how many files will be downloaded and deleted; unsynced local changes are discarded. It bypasses the mass-delete safety limit (you have explicitly declared the remote authoritative) but aborts without deleting anything if the remote listing can't be fully read — handy for making a device follow the remote after migrating from another sync tool.

## [0.7.21] - 2026-07-04

### Added
- Bulk force-resolution in the Sync status dialog: pick a strategy (Use remote / Use local / Latest modified / Biggest size) once and apply it to every listed conflict at once, instead of clearing them one dropdown at a time. Ties (equal modification time / size) are left untouched and failures stay conflicted, so nothing is silently lost.

### Fixed
- Frontmatter (YAML properties) conflicts are now resolved as structured data, never as text. Conflict markers (`<<<<<<<` / `>>>>>>>`) can no longer land inside a note's `---` block (which used to break Obsidian's Properties and re-nest on the next sync). List fields (tags, aliases, related) merge as a true 3-way set: a tag deleted on one device is actually removed instead of resurrecting, near-duplicate spellings (`#tag` vs `tag`) collapse to one, and out-of-band changes made by server-side tools propagate correctly.
- "Use remote" / "Use local" / "Latest modified" / "Biggest size" force-resolution now recovers a genuine marker-free version. When a text conflict wrote merge markers into a note, force-resolving from the Sync status dialog used to re-sync the marker-filled content while only clearing the warning; the plugin now snapshots both clean sides at conflict time and clears the conflict only once the note is actually clean.

## [0.7.20] - 2026-07-02

### Fixed
- Conflicts caused by a leftover conflict-marker line (a lone `<<<<<<< LOCAL` or `>>>>>>> REMOTE` from an incomplete manual resolution) no longer dead-lock. Such a file used to re-conflict on every sync forever because it was held without ever being pushed; it is now merged normally, converges, and removes the stray marker from both local and remote (self-heal). Complete marker sets and nested markers are still held as before.

### Added
- Per-file force resolution in the Sync status dialog: each conflicted file gets a dropdown (Use remote / Use local / Latest modified / Biggest size) and an Apply button that resolves it immediately. Ties (equal modification time / size) do nothing; failures leave the file conflicted.

## [0.7.19] - 2026-07-01

### Changed
- Frontmatter merge is now semantic: array fields (`tags`, `aliases`, `related`, …) are union-merged across devices with deduplication; scalar fields (`title`, `status`, …) are resolved by 3-way comparison — a one-sided change auto-resolves, a true conflict is decided by a new configurable policy (latest-modified / remote-wins / local-wins, default: latest-modified). Notes without frontmatter are unaffected. The policy is exposed as "Frontmatter scalar conflict [experimental]" in the Conflict Resolution section of settings.

## [0.7.18] - 2026-06-30

### Fixed
- Conflict merges are now more accurate: when the same note is edited on two devices, the plugin uses the last-synced version as a true 3-way merge base, so automatic merges are cleaner and lose fewer edits.
- Stopped a re-entrancy loop where existing conflict markers were re-merged on every sync, which previously made affected notes grow without bound.
- A no-op "tie" no longer short-circuits a needed re-sync via the root-ETag fast path, closing a path that could drop changes.

## [0.7.17] - 2026-06-30

### Fixed
- On phones, the editable number box added beside each settings slider in 0.7.16 expanded to the full row and pushed the slider off-screen. It is now pinned to a compact width so both the number box and the slider stay visible and usable.

## [0.7.16] - 2026-06-30

### Changed
- Conflict resolution is now chosen per file type. The three former settings (auto-merge toggle, frontmatter conflict strategy, merge-failure policy) collapse into an **Auto merge file types** list plus an **Auto merge file strategy** and an **Other file strategy**. Each strategy is one of Merge (3-way), Latest modified, Biggest size, Local wins, or Remote wins; every conflict is always decided (no hold/error mode). A size/mtime tie is left untouched and re-evaluated next sync. Old settings migrate automatically and the obsolete keys are pruned.
- Under the Merge strategy, a non-text (binary) file is left untouched and flagged instead of having conflict markers written into it, and an expansion guard downgrades a merge that would duplicate content (a rare empty-base reconcile bug) to a conflict rather than writing the corrupted result.

### Added
- Every numeric settings slider now has an editable number box beside it, so an exact value can be typed with the keyboard. Out-of-range values are clamped, invalid entries revert to the previous value, and the box and slider stay in sync.

## [0.7.15] - 2026-06-29

### Changed
- The "Maximum file size" setting now applies to downloads as well as uploads. A remote file larger than the limit is skipped before it is fetched — using the size the server advertises in PROPFIND (`getcontentlength`) as the source of truth — so a large note can no longer crash the app by being buffered into memory on mobile (issue #8). The skip is non-destructive and self-healing: raising the limit lets the next sync download the file normally.

## [0.7.14] - 2026-06-27

### Fixed
- Fixed slider value truncation on mobile: multi-digit values such as "15" or "30" were clipped to ".." on narrow screens. The value label now uses `flex-shrink: 0; white-space: nowrap` so it stays fully visible at all screen widths.

## [0.7.13] - 2026-06-27

### Changed
- Folded the separate *Sync on startup* toggle into the *Startup sync delay* slider: `0` now means no startup sync and `1`–`10` s sets the delay. Revised the numeric slider ranges and steps so *Sync interval* steps in 4-minute increments (0–60, where 0 = manual only) and *Network concurrency* runs 0–60 in steps of 4 (0 behaves as 1).

### Migration
- Existing settings are preserved automatically on upgrade: an install that previously had startup sync turned off keeps it off (delay collapses to 0).

## [0.7.12] - 2026-06-27

### Changed
- Removed five low-value settings from the UI and pinned each to its best fixed behavior: file locking is always off (an always-on `If-Match` precondition provides lost-update safety without LOCK/UNLOCK round trips), chunked upload is always on, the chunk threshold is platform-derived (50 MB on desktop, 20 MB on mobile), max conflict regions is always unlimited, and *Compare with remote* is always available in the explorer menu and command.

### Migration
- Any custom values previously saved for these five settings are cleaned up automatically on upgrade, so every install follows the same single path.

## [0.7.11] - 2026-06-26

### Changed
- Debug settings reduced to a single toggle: the Device name and Log folder fields were removed, leaving only *Enable logging (troubleshooting)*. The device name is now derived automatically and logs always go to the vault root (sync log records all operations, debug log is verbose).

### Migration
- Any custom device name or log folder previously set is reset to the automatic/vault-root defaults on upgrade, so every install follows the same path. Log files already written to a previous custom folder are left in place.

## [0.7.10] - 2026-06-26

### Added
- User-configurable excluded folders: specify folder paths to skip during sync
- Inline autocomplete suggestions when adding excluded folder paths
- Selectable conflict-failure policy: choose between `mark` (conflict markers), `keep-local`, `keep-remote`, or `revert` when auto-merge fails
- Compare with remote command now available on mobile (vertical diff layout)
- Startup sync toggle for mobile devices

### Changed
- Config-folder sync reorganised into two categories: **Bookmarks** and **Others**
- All sync settings are now user-editable in the Settings UI; `DEFAULT_SETTINGS` is the single source of truth. A new **Debug** section groups device name, log folder, and the logging toggle.

## [0.7.9] - 2026-06-25

- **Fix: notes with very long names failed to sync onto Android** — a file whose own name was within the filesystem's 255-byte per-component limit could still fail to download with a `FILE_NOTCREATED` error, because the temporary file used during the atomic write appended an 18-byte suffix that pushed the temporary name over the limit (Japanese titles, at 3 bytes per character, hit this around 80 characters). The temporary file now uses a short, fixed-length hashed name in the target's own directory, so its length no longer depends on the target name and any note whose own name fits is written reliably (the rename stays atomic). A name that genuinely exceeds 255 bytes — unavoidable at the OS level — is now reported as a clear "file name too long (N bytes / max 255)" message instead of an opaque error.

## [0.7.8] - 2026-06-23

- **Fix: regression where downloads were refused on mobile** — the download safety guard added in 0.7.7 compared the received `arrayBuffer.byteLength` against the server-advertised `getcontentlength` and rejected any mismatch. On iOS, Obsidian's `requestUrl` reports a byte length that legitimately differs from the server's content-length (verified against the live server: PROPFIND == GET Content-Length == actual bytes are all consistent; only the client count differs, scaling with multi-byte content), so legitimate downloads were refused and remote→local sync stalled. The guard now only rejects a genuinely empty (0-byte) body for a file advertised as non-empty. Write-back verification (size of what was just written) is unaffected.
- **Fix: Sync Status filter readability on mobile** — the per-status filter is rendered as a full-width set of chips with a clear selected state instead of cramped, overlapping checkboxes.

## [0.7.7] - 2026-06-23

- **Multi-device data-safety hardening** — several rare cross-device edge cases that could lose or strand changes are fixed: (1) a file edited or created inside a folder another device had deleted now syncs reliably instead of failing repeatedly with HTTP 404 (a stale "already-created directory" cache no longer defeats the reactive folder re-creation); (2) the mass-deletion safety brake now records an error so the unchanged-sync fast path is disarmed and "re-sync to retry" actually re-evaluates; (3) a misbehaving server that advertises a non-empty file but returns an empty/truncated body is refused instead of overwriting the local copy (legitimately emptied files still sync — zero false positives), and local writes are size-verified after saving to catch truncation/corruption.
- **Expanded automated testing** — a new live two-device end-to-end suite checks many cross-device scenarios (deletes, renames, concurrent edits, every conflict-policy combination) for data loss, endless re-syncing, and one-way sync gaps.

## [0.7.6] - 2026-06-23

- **Fix: a rare multi-device data-loss case is closed** — when a conflict was left unresolved (the "error" failure policy) and the remote was otherwise unchanged, the next sync could silently overwrite the other device's edit with the local copy via the unchanged-sync fast path introduced in 0.7.5. The fast path now disarms itself after any sync that leaves a conflict, error, or pending retry, so an unresolved remote change is always re-detected instead of being lost.

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

[0.7.25]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.25
[0.7.24]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.24
[0.7.23]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.23
[0.7.22]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.22
[0.7.21]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.21
[0.7.20]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.20
[0.7.19]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.19
[0.7.18]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.18
[0.7.17]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.17
[0.7.16]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.16
[0.7.15]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.15
[0.7.14]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.14
[0.7.13]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.13
[0.7.12]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.12
[0.7.11]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.11
[0.7.10]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.10
[0.7.9]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.9
[0.7.8]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.8
[0.7.7]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.7
[0.7.6]: https://github.com/siosig/obsidian-nextcloudsync/releases/tag/0.7.6
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
