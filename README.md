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

## What's new in this release (0.2.10)

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
- **Mobile diagnostics** — Debug mode writes a per-device `nextcloud-sync-debug.md` log on mobile too, and "Sync now" shows a result notice.
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
| Concurrent edits | Hope nobody else writes | **Files Locking** — acquire a server lock around each update to *prevent* conflicts |
| Recovery from mistakes | None (your copy is all you have) | **Server version history** — browse and restore any past revision from inside Obsidian |
| Server unavailable | Cryptic errors / partial writes | **Maintenance-mode detection** (`/status.php`) and parsed Nextcloud error messages |
| Capability awareness | None | **Capabilities probing** (`/ocs/.../capabilities`) — features light up only when the server supports them (Progressive Enhancement) |

If you point it at a non-Nextcloud WebDAV server, it automatically disables the Nextcloud-only features and falls back to standard recursive WebDAV sync — so it still works, just without the extras.

---

## Features

### Core sync
- **Bidirectional sync** between Obsidian and Nextcloud.
- **Hash-based differential sync** — only changed files are transferred (no full rescans), so a 1,000-file Vault settles in seconds.
- **Dry-run preview** — see exactly what will upload / download *before* the first sync runs, and approve it. Conflicted files explain how they'll be resolved, and clicking one opens a read-only before/after preview of the merged result.
- **Atomic writes** — a download interrupted mid-transfer never leaves a half-written or 0-byte file in your Vault.
- **Rename / move tracking** via Nextcloud file IDs — moving a note doesn't re-upload it everywhere.
- **Trashbin deletes** — remote deletions use the Nextcloud trashbin (recoverable). When a deletion is applied to your local Vault, it follows **your Obsidian "Deleted files" setting** (system trash / move to `.trash` / permanently delete) rather than forcing one behavior; folders and files outside the Vault's tracked notes (e.g. config-folder files) are handled too.
- **Per-Vault configuration** — each Vault can target a different Nextcloud server / account without state bleeding between them.
- **Periodic auto-sync** with a configurable interval (set to `0` for manual-only), plus a **Sync now** command.
- **Sync on file change (watch mode)** — optionally sync immediately after you edit a local Markdown file (debounced ~2s after you stop typing). Toggle on/off in settings; works alongside the periodic interval.
- **Resilient retries** — failed files are skipped, queued, and retried next sync with exponential backoff; a dropped Wi-Fi connection resumes automatically.
- **Standard WebDAV fallback** — works against any WebDAV server (recursive), Nextcloud features auto-disabled.
- **Debug mode (diagnostic log)** — a settings toggle (available on desktop **and** mobile) that appends a timestamped, per-device action log to `nextcloud-sync-debug.md` at the vault root while syncing normally. Useful for troubleshooting on mobile where there's no console. The log file syncs like any other note, so multiple devices' actions are collected together; turn it off and delete the file when finished.

### Conflict safety (never lose content)
- **Auto-merge** (`reconcile-text` / diff3) for edits in different regions, including YAML frontmatter when the two sides changed non-overlapping lines (on by default).
- **Merge scope by extension** — only files with a configurable extension (default `md`, `txt`) are text-merged; other files (images, PDFs, binaries) are never merged and never get markers written into them.
- **Conflict-resolution policy** for anything that can't be cleanly merged: **Error** (leave both sides untouched, report it, and retry next sync — the default), **Local wins** (overwrite remote with local), **Remote wins** (overwrite local with remote), or **Conflict markers** (Git-style `<<<<<<< LOCAL` / `=======` / `>>>>>>> REMOTE` written into the file; text files only — other files fall back to Error).
- **Conflict badge** in the status bar showing the count of unresolved conflicts (clears to normal at zero; pairs well with a `#conflict` tag search).

### Nextcloud power features
- **Login Flow v2** — set up with a browser approval instead of manually issuing and pasting an app password. Credentials are stored in Obsidian's secret credentials store, **never in plain text** in `data.json`.
- **Server version history** — for the active note, list every revision the server holds (newest first) and restore any of them atomically, with confirmation. The restored content syncs back cleanly without triggering an infinite conflict loop.
- **Chunked upload** — large attachments (images, PDFs, audio) above the chunk threshold are split and uploaded resumably; interrupted uploads never publish a partial file, and completion is checksum-verified. A separate absolute `maxFileSizeMB` cap guards memory.
- **Files Locking** *(experimental, opt-in)* — acquires a per-file server lock immediately before each update and releases it right after, preventing concurrent-write conflicts from other clients (Nextcloud desktop/web). Stale locks from a crashed run are safely detected and released.

---

## Mobile (iOS / Android)

Mobile is supported, with a few platform-aware differences (desktop behaviour is unchanged):

- **Automatic sync is off by default on mobile.** The OS suspends background timers, so periodic auto-sync and "sync on file change" are disabled (greyed out). Use **Sync now**, or enable **Sync on startup** (off by default on mobile) to sync once a few seconds after the app opens.
- **Sync on startup** is a new setting on both platforms (desktop: on, 5 s; mobile: off).
- **Large files are skipped on mobile** above the "Maximum file size" limit (set `0` for unlimited) to avoid out-of-memory crashes; skips are reported.
- **No progress UI on mobile** — only error notices are shown.
- **Network concurrency** is configurable (desktop default 8, mobile default 2).
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
5. Run the **Sync now** command (or wait for the periodic sync). On the first run you'll get a **dry-run preview** (`N uploads / M downloads`) to approve.

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

- App passwords / credentials are kept in Obsidian's **secret credentials store**, never written in plain text to `data.json`.
- Your **main account password is never used or stored** — only app passwords (issued manually or via Login Flow v2).
- All network traffic uses Obsidian's `requestUrl` API.
- The plugin's own folder (`.obsidian/plugins/nextcloud-sync/`) is excluded from sync.

---

## Limitations

- **End-to-end encryption (E2EE)** is out of scope for this version.
- Designed primarily for Markdown / text Vaults; single files in the hundreds-of-MB range are beyond the v1 design target.
- Keep the Vault on local storage — don't double-manage it with another cloud sync (e.g. iCloud Drive) at the same time.
- Nextcloud-specific features require a compatible server version; older or non-Nextcloud servers transparently fall back to core WebDAV sync.

---

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/siosig/obsidian-nextcloudsync).

---

## License

[MIT](LICENSE) © Daisuke ITO
