# Nextcloud Sync for Obsidian

**Good news for anyone working across multiple desktops and mobile devices.**

The only cost you pay is waiting for the initial Vault index to complete on first install. From that moment on, you get:

- **Your writing is never lost** — the merge logic keeps your Vault in a clean, consistent state even when the same note is edited on multiple devices at once.
- **Sync fades into the background** — Nextcloud's fast differential sync means you'll stop noticing sync time altogether.
- **Works beyond Nextcloud too** — with slightly reduced features, it works against any standard WebDAV server as well.

---

Bidirectional sync between your Obsidian Vault and Nextcloud — built **specifically for Nextcloud**, not just generic WebDAV.

Most "WebDAV sync" plugins treat the server as a dumb file store: they compare modification times, copy files, and hope for the best. **Nextcloud Sync** instead talks to Nextcloud's own APIs (Capabilities, file IDs, checksums, versions, locking, Login Flow v2) to make syncing *safe*, *fast*, and *frictionless* — while still degrading gracefully to plain WebDAV when those APIs aren't available.

> A Japanese translation is available at [`README.ja.md`](README.ja.md).

---

## 💬 Your feedback shapes this plugin

This plugin is still young and some behaviour can be rough around the edges. **Please tell me what you run into — it genuinely helps.** Whether something broke, something's missing, or you just have a thought after using it, I'd love to hear from you (impressions especially make my day!):

- 🐛 **Report a bug** → [GitHub Issues](https://github.com/siosig/obsidian-nextcloudsync/issues)
- 🙋‍♂️ **Request a feature / share your impressions** → [GitHub Discussions](https://github.com/siosig/obsidian-nextcloudsync/discussions)

---

## What's new in this release (0.7.1-beta.1)

- **Fix: the plugin's own log files no longer error or churn during sync (0.7.1-beta.1)** — a per-device debug/sync log (e.g. `_logs/nextcloud-sync_debug_<device>.txt`) is written *while* a sync runs, so syncing that live file raced its own write and reported "Destination file already exists!" every sync. The plugin now keeps its log file out of sync **only while that log's output toggle is ON**. Turn **Sync log** / **Debug log** OFF and the now-static file syncs normally again; another device's log is never excluded, so cross-device log collection still works.

## 0.7.0

- **Faster mobile sync via Vault-cache enumeration (0.7.0)** — local scanning now reads Obsidian's in-memory file index (`Vault.getFiles`) instead of making per-file native filesystem calls, removing the O(N) bridge round-trips that made sync slow on mobile. The initial scan also hashes only the files that actually need a checksum comparison, and network concurrency now scales with device memory uniformly across desktop and mobile (no platform-specific branch). Dot paths that `Vault.getFiles` omits are re-enumerated so they keep syncing.

## 0.7.0-beta.1

- **Faster mobile sync via Vault-cache enumeration (0.7.0-beta.1)** — local scanning now reads Obsidian's in-memory file index (`Vault.getFiles`) instead of making per-file native filesystem calls, removing the O(N) bridge round-trips that made sync slow on mobile. The initial scan also hashes only the files that actually need a checksum comparison, and network concurrency now scales with device memory uniformly across desktop and mobile (no platform-specific branch).

## 0.6.1

- **New "Reset vault index" maintenance action (0.6.1)** — a new **Settings → Maintenance** section adds a button that clears this device's sync tracking index back to its first-install state (behind a confirmation), so the next sync re-scans everything from scratch. No Vault or remote files are deleted, and an in-progress sync is aborted first. The existing **Last session summary** entry now lives in this Maintenance section too.
- **First sync no longer shows a preview/approval step (0.6.1)** — the initial-sync "dry run" confirmation modal has been removed; the first sync now scans and applies its plan directly. The reset action's confirmation is the deliberate point at which a full re-scan is acknowledged.

## 0.6.0

- **Much faster sync — mobile/Android no longer stalls (0.6.0)** — change detection now uses a stat signature recorded *as written* instead of relying on setting the modification time (a no-op on mobile), so a re-sync no longer re-reads and re-hashes the whole vault; the first sync no longer hashes the vault twice; transfers run with bounded parallelism capped by a memory-safe byte budget; file locking now defaults off with an `If-Match` optimistic-concurrency guard (fewer round trips, still no lost updates); and large server listings no longer freeze the UI.
- **Sync Status dialog reachable on mobile, grouped by sync run (0.6.0)** — the settings **Last session summary** button opens the full Sync Status dialog on both desktop and mobile. Recent activity is grouped by sync run, each group headed by a separator showing that run's start time in 24-hour format, and your status-filter selection is remembered across restarts.

## 0.6.0-beta.2

- **Sync Status dialog reachable on mobile, grouped by sync run (0.6.0-beta.2)** — the settings **Last session summary** button now opens the full Sync Status dialog on both desktop and mobile (previously a one-line toast, and mobile had no way to reach the dialog at all). Recent activity is now grouped by sync run, each group headed by a separator showing that run's start time in 24-hour format, and your status-filter selection is remembered across restarts.

## 0.6.0-beta.1

- **Much faster sync — mobile/Android no longer stalls (0.6.0-beta.1)** — change detection now records the file's modification time/size *as written* and compares against that, instead of relying on setting the modification time (which is a no-op on mobile). Previously every sync re-read and re-hashed the entire vault on mobile, eventually getting killed by the OS; now an unchanged file is skipped without being read. A same-size edit made within a 2-second window is still always detected (no lost edits).
- **Faster first sync (0.6.0-beta.1)** — the initial sync no longer hashes the whole vault twice, decides "already in sync" by size first, and skips pre-hashing very large files.
- **Parallel transfers with a memory guard (0.6.0-beta.1)** — uploads/downloads now run with bounded concurrency (configurable; mobile default raised to 3), capped by a total in-flight-bytes budget so large files can't exhaust memory, with same-folder uploads serialized to avoid server lock contention.
- **Fewer network round trips (0.6.0-beta.1)** — file locking now defaults **off**, replaced by an `If-Match` precondition that turns a remote changed by another device into a conflict (no lost update) without the extra LOCK/UNLOCK requests; directory creation is now done only when needed, and deletes treat "already gone" as success.
- **Snappier UI on large vaults (0.6.0-beta.1)** — parsing a large server file listing no longer freezes the interface.

## 0.5.0

- **Selective `.obsidian` config folder sync (0.5.0)** — opt in via **Sync config folder** in settings to sync chosen categories of the Obsidian config folder across devices: Appearance, Themes & snippets, Hotkeys, Core plugin settings, and Bookmarks (each its own toggle, modelled on Obsidian native Sync). Off by default — notes still sync as before. **Community plugins (`.obsidian/plugins/`) and the plugin's own sync-state database are never synced** (executable code / device-specific state). Config files conflict-resolve by newest-wins so they are never corrupted with conflict markers. The previous standalone **Sync bookmarks** setting migrates automatically into the Bookmarks category, so existing bookmark-sync users keep working with no change. Resolves [#1](https://github.com/siosig/obsidian-nextcloudsync/issues/1).

## 0.4.1

- **Log files are now created even when the log folder does not exist yet (0.4.1)** — fixes a bug where, if the configured log folder (e.g. `_logs`) did not already exist, the per-device sync and debug logs were silently never written. The plugin now creates the parent folder before the first write.

## 0.4.0

- **Filter the sync-status dialog by status (0.4.0)** — the status dialog gained a checkbox row (Uploaded, Downloaded, Deleted, Merged, Conflicted, Local wins, Remote wins, Error) so you can focus on, say, only conflicts.
- **Compare a file with its remote version (0.4.0)** — opt in via "Compare with remote (explorer menu)" in settings, then right-click any file in the explorer to open a popup comparing local vs remote modification time, checksum (with a match/mismatch badge), and a line diff. Resolve the difference there with **push** or **pull**, each behind a confirmation.
- **Files that differ between local and remote now always reconcile (0.4.0)** — fixes a case where, on servers that return no content checksum (ETag fallback), a note could differ between this device and the server yet never sync; such a file is now detected and reconciled through normal conflict resolution.
- **Plain-text log files now use a .txt extension (0.4.0)** — per-device sync and debug logs are plain text, so they use a `.txt` extension to avoid being rendered as Markdown. Existing `.md` log files are left untouched.
- **Internal refactor & documentation alignment (0.4.0)** — brings the code in line with the official Obsidian developer guidelines: vault watchers and engine init are deferred to `onLayoutReady`, local paths are normalized at the IO boundary, modal titles use the native title bar, and the diff/error styling follows your theme's colors.

## 0.4.0-beta.4

- **Internal refactor & documentation alignment (0.4.0-beta.4)** — a maintenance release with no user-facing behavior change. Brings the code in line with the official Obsidian developer guidelines: vault watchers and engine init are now deferred to `onLayoutReady` (avoiding the "create fires per file on startup" pitfall), local paths are normalized at the IO boundary, modal titles use the native title bar, and the diff/error styling now follows your theme's colors. Also fixes a few README details that had drifted from the actual behavior, and removes dead code.

## 0.4.0-beta.3

- **Plain-text log files now use a .txt extension (0.4.0-beta.3)** — the per-device sync and debug logs are plain text, not Markdown, so they now use a `.txt` extension to avoid being rendered as Markdown (which garbled the display). Existing `.md` log files are left untouched and can be deleted; new entries are written to the `.txt` files. `.txt` is in the default mergeable extensions, so cross-device log merging keeps working.

## 0.4.0-beta.2

- **Files that differ between local and remote now always reconcile (0.4.0-beta.2)** — fixes a case where, on servers that return no content checksum (so the plugin falls back to ETags), a note could differ between this device and the server yet never sync. The recorded sync state could become internally inconsistent and make the file look "unchanged" forever; such a file is now detected (by size) and reconciled through normal conflict resolution instead of being silently skipped.

## 0.4.0-beta.1

- **Filter the sync-status dialog by status (0.4.0-beta.1)** — the status dialog gained a checkbox row (Uploaded, Downloaded, Deleted, Merged, Conflicted, Local wins, Remote wins, Error) so you can focus on, say, only conflicts. All on by default; the choice is remembered until you restart Obsidian and applies to every section of the dialog.
- **Compare a file with its remote version (0.4.0-beta.1)** — opt in via "Compare with remote (explorer menu)" in settings, then right-click any file in the explorer to open a popup comparing local vs remote modification time, checksum (with a match/mismatch badge), and a line diff. Resolve the difference there with **push** (overwrite remote with local) or **pull** (overwrite local with remote), each behind a confirmation. The toggle takes effect immediately — no restart.

## 0.3.1

- **Maintenance release (requires Obsidian 1.11.4+)** — no functional changes. Restores the community-directory listing by fixing an internal lint issue (an undescribed ESLint directive) that failed the 0.3.0 automated review, and re-enables the repository's git hooks so the pre-push gate mirrors the directory reviewer.

## 0.3.0

- **Reorganized settings into four sections** — settings are grouped under **Nextcloud**, **Sync**, **Merge**, and **Debug** headings instead of one long flat list. "Max conflict regions" now shows its numeric value beside the slider and defaults to **0 = unlimited** (the region-count circuit-breaker no longer forces conflict markers by default).
- **Per-device logging** — two opt-in logs written to a folder you pick (a fuzzy folder picker; defaults to the vault root) and named per device so multiple devices never overwrite one another:
  - **Sync log** (`nextcloud-sync_sync_<device>.txt`) — one appended block per sync with the plugin version and all merge-related settings in the header, then one line per operation showing the marker, path, and local/remote checksums and sizes. A level switch records *important events only* (conflicts, merges, side-wins, errors) or *all operations*.
  - **Debug log** (`nextcloud-sync_debug_<device>.txt`) — a timestamped diagnostic log with selectable verbosity (error / debug / verbose), the plugin version, and a snapshot of all settings. Replaces the old single vault-root debug file; the legacy "Debug mode" toggle migrates automatically.
- **Stuck conflict count fixed** — a file that was once flagged as conflicted but has since converged (identical on both sides) now clears its flag on the next sync, so the conflict count no longer stays stuck at a non-zero number.
- **No telemetry** — the plugin collects no usage data, analytics, or crash reports; the only network traffic is the sync with your own server. Obsolete settings from earlier builds are also pruned from `data.json` on load.

## 0.3.0-beta.2

- **Stuck conflict count fixed (0.3.0-beta.2)** — a file that was once flagged as conflicted but has since converged (identical on both sides) now clears its flag on the next sync, so the conflict count no longer stays stuck at a non-zero number.
- **Settings cleanup on load (0.3.0-beta.2)** — obsolete settings left over from earlier builds are pruned from `data.json` automatically.

## 0.3.0-beta.1

- **Reorganized settings into four sections (0.3.0-beta.1)** — settings are now grouped under **Nextcloud**, **Sync**, **Merge**, and **Debug** headings instead of one long flat list, so each option is easier to find. "Max conflict regions" now shows its numeric value beside the slider and defaults to **0 = unlimited** (the region-count circuit-breaker no longer forces conflict markers by default).
- **Per-device logging (0.3.0-beta.1)** — two opt-in logs written to a folder you pick (a fuzzy folder picker; defaults to the vault root) and named per device so multiple devices never overwrite one another:
  - **Sync log** (`nextcloud-sync_sync_<device>.txt`) — one appended block per sync with the plugin version and all merge-related settings in the header, then one line per operation showing the marker, path, and local/remote checksums and sizes. A level switch records *important events only* (conflicts, merges, side-wins, errors) or *all operations*.
  - **Debug log** (`nextcloud-sync_debug_<device>.txt`) — a timestamped diagnostic log with selectable verbosity (error / debug / verbose), the plugin version, and a snapshot of all settings. Replaces the old single vault-root debug file; the legacy "Debug mode" toggle migrates automatically.

## 0.2.10

- **Clearer conflict reporting (0.2.10)** — the sync-status dialog and summary now distinguish between two outcomes: **merged** (the file was auto-merged cleanly) and **conflicted** (conflict markers were left in the file). Previously both were lumped under a single "conflict" count, making it hard to tell whether action was needed.
- **Manual "Sync now" button and live 24-hour activity (0.2.7)** — the sync-status dialog gained a **Sync now** button at the top, a scrollable **last-24h activity history** (one compact, icon-led line per file), and now applies a changed auto-sync interval immediately without needing a reload.
- **Installs on more setups (0.2.8)** — the minimum required Obsidian version was corrected down to `1.11.4` (the true minimum the plugin needs), instead of effectively requiring only the very latest release.
- **Passes Obsidian's automated store review (0.2.9)** — inline styling moved to CSS classes and UI text to sentence case, clearing the Community-plugins automated checks that had delisted the entry.

Earlier in the 0.2.x line:

- **Watch-mode self-feedback loop fixed (0.2.6)** — the plugin's own writes (downloads, merged conflicts) are no longer re-detected as user edits, eliminating spurious re-uploads, error storms, and unintended remote deletes when "Sync on file change" is enabled.
- **One failing file no longer aborts the sync (0.2.6)** — a per-file error (e.g. a server-side 403) is recorded and the rest of the session continues; network errors are still queued for retry with backoff.
- **Error details in the sync-status dialog (0.2.6)** — clicking the status bar now also shows an "Errors in last sync" list (one row per failed file, clickable to open it) instead of only an opaque error count.
- **State database saves are serialized (0.2.6)** — concurrent watch-mode syncs can no longer race each other into a corrupted or missing sync-state file.

- **Remote-deletion scope guard (security hardening, 0.2.5)** — server-reported deletions are validated against the sync scope before being applied, so a malicious or compromised server can no longer make the client delete files outside the synced folder (e.g. under `.obsidian/`).
- **Sturdier downloads (0.2.4)** — the parent folder is created before each atomic write, and per-file non-network errors no longer stop the remaining files from syncing.
- **Conflict-resolution policy (0.2.2)** — choose what happens when a conflict can't be cleanly auto-merged: leave both sides untouched and retry (**Error**, the default), keep **Local**, keep **Remote**, or embed **conflict markers**. Configurable in settings.
- **Merge limited to text files (0.2.2)** — only configurable extensions (default `md`, `txt`) are ever text-merged. Other files (images, PDFs, binaries) are never merged, so conflict markers can no longer corrupt them. The default conflict outcome changed from embedding `<<<<<<<` markers to **Error** (skip and retry on the next sync).
- **Reliable cross-device deletions** — deleting a file on one device now propagates correctly instead of the file reappearing on the next sync (sync-token handling fixed, with content-verified, recoverable deletions and a mass-deletion safety guard).
- **Auto-merged conflicts now reach the server** — a merged conflict is uploaded so all devices converge, instead of the same conflict re-appearing every sync.
- **Mobile diagnostics** — the debug log writes a per-device `nextcloud-sync_debug_<device>.txt` on mobile too, and "Sync now" shows a result notice.
- **Mobile (iOS / Android) support** — the plugin now runs on mobile, with platform-aware behavior so desktop is unchanged (details in the Mobile section below).
- **Clickable status bar → sync-status dialog** — click the status bar item to open a dialog summarizing the current sync state, the last sync, any unresolved conflicts, and (since 0.2.6) any per-file errors from the last sync.
- **"Sync now" promoted to the top of settings** and gated on authentication, so you can trigger a sync the moment you're signed in.
- **Platform-aware default settings** — defaults are tuned per platform (e.g. network concurrency, sync-on-startup, maximum file size).
- **YAML frontmatter is now auto-merged** — non-overlapping frontmatter edits merge cleanly (via diff3), falling back to conflict markers only when both sides change the same lines.
- **Clearer conflict outcomes in the dry-run** — the first-sync preview now explains what conflict resolution will produce, and each conflicted file is clickable to preview the exact merged before/after result.
- **Faster than generic WebDAV** — by diffing content hashes against Nextcloud's `sync-token`, each sync transfers only what actually changed instead of recursively walking the entire remote tree on every run, so syncs complete noticeably faster than modification-time-based WebDAV plugins.

---

## Why Nextcloud-specific? (vs. generic WebDAV)

| Concern | Generic WebDAV plugin | **Nextcloud Sync** |
|---------|-----------------------|--------------------|
| Change detection | Modification time (clock-skew prone, false re-uploads) | **Content hash** + Nextcloud `sync-token` / checksums capability for true differential sync |
| Rename / move | Delete + re-create (loses history, re-downloads everywhere) | **File-ID (`OC-FileId`) tracking** — a rename stays a rename on every device, history preserved |
| Deletion safety | Hard delete | Routed through the **Nextcloud trashbin** — recoverable, never an irreversible `DELETE` |
| Setup | Manual app-password copy & paste | **Login Flow v2** — approve in the browser, credentials are issued and stored automatically |
| Large files | Skipped or fail on a single `PUT` | **Chunked upload** — split, resumable, checksum-verified |
| Concurrent edits | Hope nobody else writes | **Optimistic concurrency** — every update carries an `If-Match` precondition, so a remote changed by another device is turned into a conflict (no lost update) without locking round trips; server-side **Files Locking** stays available as an opt-in |
| Recovery from mistakes | None (your copy is all you have) | **Server version history** — browse and restore any past revision from inside Obsidian |
| Server unavailable | Cryptic errors / partial writes | **Maintenance-mode detection** (`/status.php`) and parsed Nextcloud error messages |
| Capability awareness | None | **Capabilities probing** (`/ocs/.../capabilities`) — features light up only when the server supports them (Progressive Enhancement) |

If you point it at a non-Nextcloud WebDAV server, it automatically disables the Nextcloud-only features and falls back to standard recursive WebDAV sync — so it still works, just without the extras.

---

## Features

### Core sync
- **Bidirectional sync** between Obsidian and Nextcloud.
- **Hash-based differential sync** — only changed files are transferred (no full rescans), so a 1,000-file Vault settles in seconds.
- **Atomic writes** — a download interrupted mid-transfer never leaves a half-written or 0-byte file in your Vault.
- **Rename / move tracking** via Nextcloud file IDs — moving a note doesn't re-upload it everywhere.
- **Trashbin deletes** — remote deletions use the Nextcloud trashbin (recoverable). When a deletion is applied to your local Vault, it follows **your Obsidian "Deleted files" setting** (system trash / move to `.trash` / permanently delete) rather than forcing one behavior; folders and files outside the Vault's tracked notes (e.g. config-folder files) are handled too.
- **Per-Vault configuration** — each Vault can target a different Nextcloud server / account without state bleeding between them.
- **Periodic auto-sync** with a configurable interval (set to `0` for manual-only), plus a **Sync now** command.
- **Sync on file change (watch mode)** — optionally sync immediately after you edit a local file (debounced ~2s after you stop typing). Toggle on/off in settings; works alongside the periodic interval.
- **Resilient retries** — failed files are skipped, queued, and retried next sync with exponential backoff; a dropped Wi-Fi connection resumes automatically.
- **Standard WebDAV fallback** — works against any WebDAV server (recursive), Nextcloud features auto-disabled.
- **Filter the sync-status dialog by status** — the status dialog has a checkbox row (Uploaded, Downloaded, Deleted, Merged, Conflicted, Local wins, Remote wins, Error) so you can focus on, say, only conflicts. All on by default; the choice is remembered until you restart Obsidian and applies to every section.
- **Compare a file with its remote version** *(opt-in)* — enable "Compare with remote (explorer menu)" in settings, then right-click any file in the explorer to open a popup comparing local vs remote modification time, checksum (with a match/mismatch badge), and a line diff. Resolve the difference right there with **push** (overwrite remote with local) or **pull** (overwrite local with remote), each behind a confirmation. The toggle takes effect immediately — no restart.
- **Per-device logging** — two opt-in logs, written to a folder you pick (a fuzzy folder picker; defaults to the vault root) and named per device so multiple devices never overwrite one another:
  - **Sync log** (`nextcloud-sync_sync_<device>.txt`) — one appended block per sync with the plugin version and all merge-related settings in the header, then one line per operation showing the marker, path, local/remote checksums and sizes. A level switch records *important events only* (conflicts, merges, side-wins, errors) or *all operations*.
  - **Debug log** (`nextcloud-sync_debug_<device>.txt`) — a timestamped diagnostic log with selectable verbosity (error / debug / verbose), the plugin version, and a snapshot of all settings. Useful for troubleshooting on mobile where there's no console. Turn it off and delete the file when finished.
- **Reset the Vault index** *(Settings → Maintenance)* — clear this device's sync tracking index back to its first-install state (behind a confirmation) so the next sync re-scans everything. No Vault or remote files are deleted; use it to recover from inconsistent sync state.

### Conflict safety (never lose content)
- **Auto-merge** (`reconcile-text` / diff3) for edits in different regions, including YAML frontmatter when the two sides changed non-overlapping lines (on by default).
- **Merge scope by extension** — only files with a configurable extension (default `md`, `txt`) are text-merged; other files (images, PDFs, binaries) are never merged and never get markers written into them.
- **Conflict-resolution policy** for anything that can't be cleanly merged: **Error** (leave both sides untouched, report it, and retry next sync — the default), **Local wins** (overwrite remote with local), **Remote wins** (overwrite local with remote), or **Conflict markers** (Git-style `<<<<<<< LOCAL` / `=======` / `>>>>>>> REMOTE` written into the file; text files only — other files fall back to Error).
- **Conflict badge** in the status bar showing the count of unresolved conflicts (clears to normal at zero; pairs well with a `#conflict` tag search).

### Nextcloud power features
- **Login Flow v2** — set up with a browser approval instead of manually issuing and pasting an app password. Credentials are stored in Obsidian's secret credentials store, **never in plain text** in `data.json`.
- **Server version history** — for the active note, list every revision the server holds (newest first) and restore any of them atomically, with confirmation. The restored content syncs back cleanly without triggering an infinite conflict loop.
- **Chunked upload** — large attachments (images, PDFs, audio) above the chunk threshold are split and uploaded resumably; interrupted uploads never publish a partial file, and completion is checksum-verified. A separate absolute `maxFileSizeMB` cap guards memory.
- **Files Locking** *(experimental, off by default)* — optionally acquires a per-file server lock immediately before each update and releases it right after. **Default off:** lost-update safety is provided instead by an always-on `If-Match` precondition (a remote changed by another client returns 412, which the engine turns into a conflict), avoiding the extra LOCK/UNLOCK round trips per file. Enable it for belt-and-suspenders locking; requires the Nextcloud files-locking app and stays inactive when the app is absent.

---

## Mobile (iOS / Android)

Mobile is supported, with a few platform-aware differences (desktop behaviour is unchanged):

- **Automatic sync is off by default on mobile.** The OS suspends background timers, so periodic auto-sync and "sync on file change" are disabled (greyed out). Use **Sync now**, or enable **Sync on startup** (off by default on mobile) to sync once a few seconds after the app opens.
- **Sync on startup** is a new setting on both platforms (desktop: on, 1 s; mobile: off).
- **Large files are skipped on mobile** above the "Maximum file size" limit (set `0` for unlimited) to avoid out-of-memory crashes; skips are reported.
- **No progress UI on mobile** — only error notices are shown.
- **Network concurrency** is configurable (desktop default 16, mobile default 3). Transfers run with bounded parallelism — capped both by this count and by a total in-flight-bytes budget (smaller on mobile) so large files can't exhaust memory — and uploads to the same folder are serialized to avoid server lock contention.
- **Sync on Wi-Fi only** skips on cellular (Android/desktop). **Not available on iOS** (no network-type API), where the toggle is disabled.
- **Sync now shows a result notice on mobile** (uploads / downloads / conflicts, or "already up to date") since there's no status bar. Tapping it while not signed in stays disabled, and the settings screen shows a clear "not signed in yet" banner.
- Debug mode (diagnostic log) is available on mobile and does not change syncing.

## Requirements

- **Obsidian** `1.11.4` or later (the plugin uses the secret-storage API introduced in `1.11.4`). Desktop (Electron) and mobile (iOS / Android) are supported.
- **Nextcloud** Hub 26 "Winter" (server `33`) or later is **recommended** for the Nextcloud-specific features. Older Nextcloud servers are no longer blocked — they still connect and sync, but the settings screen shows a recommendation banner and some features may degrade. Plain WebDAV servers fall back to core sync.
- A Nextcloud account. You can authenticate with **Login Flow v2** (recommended) or a manually issued **app password** (never your main password).

---

## Installation

### From the Community Plugins browser (recommended)
1. In Obsidian, open **Settings → Community plugins**.
2. Disable Restricted mode, click **Browse**, and search for **Nextcloud Sync**.
3. **Install**, then **Enable**.

### Manual installation
1. Download `main.js` and `manifest.json` (and `styles.css` if present) from the latest [GitHub Release](../../releases).
2. Copy them into `<YourVault>/.obsidian/plugins/nextcloud-sync/`.
3. Reload Obsidian and enable **Nextcloud Sync** under **Settings → Community plugins**.

---

## Getting started

1. Open **Settings → Nextcloud Sync**.
2. Enter your **Server URL** (e.g. `https://cloud.example.com`).
3. Authenticate:
   - **Recommended:** click **Login with browser** (Login Flow v2), approve in the browser, and credentials are filled in and stored automatically; **or**
   - enter your **username** and a manually issued **app password**.
4. (Optional) Adjust the auto-sync interval, **Sync on file change** (watch mode), auto-merge, chunk threshold, and locking options.
5. Run the **Sync now** command (or wait for the periodic sync). The first run performs a full scan of your Vault and the remote, then transfers what's needed; subsequent syncs are incremental.

Your Vault is synced into a folder named after the Vault on the Nextcloud side, keeping multiple Vaults cleanly separated.

---

## Enabling Nextcloud server-side features

Two power features depend on server-side Nextcloud apps. Each only needs to be enabled **once by a Nextcloud administrator**. The plugin detects them through the capabilities API — if an app is missing, the corresponding feature simply stays inactive (no error).

### File Locking

Locking uses Nextcloud's **Temporary files lock** app (app ID `files_lock`, available since Nextcloud 24; bundled with Nextcloud Hub from v34).

- **Web UI (admin):** sign in as an administrator → profile menu (top-right) → **Apps** → search for **Temporary files lock** → **Enable** (download it first if it isn't installed).
- **Command line (`occ`)** — run as the web-server user (often `www-data`):
  ```bash
  sudo -u www-data php /var/www/nextcloud/occ app:enable files_lock
  ```
- Then enable **File Locking (Experimental)** in the plugin settings and re-sync. (Docker: `docker exec -u www-data <container> php occ app:enable files_lock`.)

### Version history

Server-side versions come from the built-in **Versions** app (app ID `files_versions`), which is **enabled by default** on a standard Nextcloud install — usually nothing to do.

- If it was disabled, re-enable it: **Apps → Versions → Enable**, or:
  ```bash
  sudo -u www-data php /var/www/nextcloud/occ app:enable files_versions
  ```
- Versions are created automatically as files change; browse and restore them with the **Show version history** command in Obsidian.
- A note must have been changed on the server at least once for prior revisions to exist. Retention is configured server-side by the admin (`versions_retention_obligation` in `config.php`).

### Other settings worth checking

These are not strictly required, but on self-hosted instances they often need attention for smooth, reliable syncing. All are server-side (admin) settings.

- **Trusted domains** — the host you connect to must be listed in `trusted_domains` in `config.php`, otherwise the server rejects requests. Add your domain/IP if needed.
- **HTTPS & reverse proxy (important for Login Flow v2)** — behind a reverse proxy, set `overwriteprotocol => 'https'`, `overwritehost`, `overwrite.cli.url`, and `trusted_proxies` correctly. If these are wrong, the URLs returned by Login Flow v2 (and downloads) can point to the wrong scheme/host and fail. Always use an `https://` server URL in the plugin.
- **Upload size limits (for chunked upload / large attachments)** — raise PHP `upload_max_filesize` and `post_max_size`, and the web-server body limit (nginx `client_max_body_size`, e.g. `0` or a large value). Chunked upload sends small chunks, but the final assembly and very large files still hit these limits.
- **Request timeouts** — for large vaults or big files, increase PHP `max_execution_time` and php-fpm / web-server timeouts (e.g. nginx `fastcgi_read_timeout`). The plugin's own network timeout is configurable in settings.
- **Brute-force protection** — Nextcloud throttles repeated requests from one IP and can return HTTP 429, especially when several devices sync from the same network or after auth errors. If you hit this, whitelist the network in **Administration settings → Security**, or set `auth.bruteforce.protection.enabled`/the IP allow-list in `config.php`.
- **Background jobs (cron)** — configure Nextcloud's recommended **Cron** background-job mode so version cleanup and other maintenance run reliably.
- **App passwords & two-factor auth** — never use your main account password; if 2FA is enabled an app password is mandatory. Login Flow v2 issues one for you automatically.
- **Checksums (optional, recommended)** — the plugin prefers Nextcloud's `oc:checksums` (SHA-256) for change detection and automatically falls back to ETag when they aren't present, so no configuration is required; leaving Nextcloud's default checksum support enabled gives the most accurate detection.

---

## How it works (in brief)

On connect, the plugin probes `/status.php` (maintenance mode) and `/ocs/v1.php/cloud/capabilities` to learn the server version and which features (`checksums`, `files locking`, …) are available. It then maintains a **per-device state database** — a snapshot of every file's path, content hash, and remote file ID at the last successful sync. Each sync diffs the current state against that snapshot and the server's `sync-token`, transferring only what changed. Every Nextcloud-specific behavior is gated behind capability detection, so the same plugin works against a full Nextcloud Hub and a bare WebDAV server alike (**Progressive Enhancement**).

---

## Privacy & security

- **This plugin collects no telemetry whatsoever.** No usage data, analytics, or crash reports are gathered or sent anywhere; the only network traffic is the sync between your vault and your own Nextcloud/WebDAV server.
- App passwords / credentials are kept in Obsidian's **secret credentials store**, never written in plain text to `data.json`.
- Your **main account password is never used or stored** — only app passwords (issued manually or via Login Flow v2).
- All network traffic uses Obsidian's `requestUrl` API.
- The Obsidian config folder (`.obsidian/`) is excluded from sync by default — only your notes and other vault files are synced. You can opt in to syncing selected parts of it via **Sync config folder** (see below). **Community plugins (`.obsidian/plugins/`) and the plugin's own sync-state database are never synced**, regardless of settings — they hold executable code and device-specific state, which is unsafe to overwrite across devices.

---

## Limitations

- **End-to-end encryption (E2EE)** is out of scope for this version.
- **Config folder sync is opt-in and selective.** Enable **Sync config folder** in settings to sync chosen categories of `.obsidian/` across devices: Appearance, Themes & snippets, Hotkeys, Core plugin settings, and Bookmarks. **Community plugins and the plugin's own sync-state database are never synced** (executable code / device-specific state). A synced change to core-plugin settings may require an Obsidian restart on the other device to take effect.
- Designed primarily for Markdown / text Vaults; single files in the hundreds-of-MB range are beyond the v1 design target.
- Keep the Vault on local storage — don't double-manage it with another cloud sync (e.g. iCloud Drive) at the same time.
- Nextcloud-specific features require a compatible server version; older or non-Nextcloud servers transparently fall back to core WebDAV sync.

---

## Contributing & feedback

Issues and pull requests are welcome on [GitHub](https://github.com/siosig/obsidian-nextcloudsync). The plugin is still maturing, so feedback of any kind is especially valuable:

- 🐛 **Report a bug** → [GitHub Issues](https://github.com/siosig/obsidian-nextcloudsync/issues)
- 🙋‍♂️ **Request a feature / share your impressions** → [GitHub Discussions](https://github.com/siosig/obsidian-nextcloudsync/discussions)

---

## License

[MIT](LICENSE) © Daisuke ITO
