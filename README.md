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

## What's new in this release (0.7.5-beta.1)

- **Faster unchanged syncs on Nextcloud (0.7.5-beta.1)** — when the vault's remote contents have not changed since the last scan, the sync now skips the full remote directory listing and reuses cached state, detected via the root folder's ETag. Measured on a real server, an unchanged sync drops from two large directory listings to a single tiny request. Correctness is unaffected: any remote change is still picked up on the next sync, and the optimization only applies to Nextcloud (plain WebDAV is unchanged).

For the full version history of every release, see the **[changelog](CHANGELOG.md)**.

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
- **Filter the sync-status dialog by status** — the status dialog has a checkbox row (Uploaded, Downloaded, Deleted, Merged, Conflicted, Local wins, Remote wins, Error) so you can focus on, say, only conflicts. All on by default; your selection is saved and persists across Obsidian restarts, and applies to every section.
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
- **Network concurrency** is configurable; its first-run default is derived from the device's available memory — uniformly on desktop and mobile, with no platform-specific branch: **16** with 8 GB of RAM or more, **8** at 4 GB or more, **4** below that, and **3** when the device doesn't report its memory (common on mobile). Transfers run with bounded parallelism — capped both by this count and by a total in-flight-bytes budget (smaller on mobile) so large files can't exhaust memory — and uploads to the same folder are serialized to avoid server lock contention.
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
