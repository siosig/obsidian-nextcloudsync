# Nextcloud Sync for Obsidian

Bidirectional sync between your Obsidian Vault and Nextcloud — built **specifically for Nextcloud**, not just generic WebDAV.

Most "WebDAV sync" plugins treat the server as a dumb file store: they compare modification times, copy files, and hope for the best. **Nextcloud Sync** instead talks to Nextcloud's own APIs (Capabilities, file IDs, checksums, versions, locking, Login Flow v2) to make syncing *safe*, *fast*, and *frictionless* — while still degrading gracefully to plain WebDAV when those APIs aren't available.

> A Japanese translation is available at [`README.ja.md`](README.ja.md).

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
- **Dry-run preview** — see exactly what will upload / download *before* the first sync runs, and approve it.
- **Atomic writes** — a download interrupted mid-transfer never leaves a half-written or 0-byte file in your Vault.
- **Rename / move tracking** via Nextcloud file IDs — moving a note doesn't re-upload it everywhere.
- **Trashbin deletes** — remote deletions use the Nextcloud trashbin (recoverable). When a deletion is applied to your local Vault, it follows **your Obsidian "Deleted files" setting** (system trash / move to `.trash` / permanently delete) rather than forcing one behavior; folders and files outside the Vault's tracked notes (e.g. config-folder files) are handled too.
- **Per-Vault configuration** — each Vault can target a different Nextcloud server / account without state bleeding between them.
- **Periodic auto-sync** with a configurable interval (set to `0` for manual-only), plus a **Sync Now** command.
- **Sync on file change (watch mode)** — optionally sync immediately after you edit a local Markdown file (debounced ~2s after you stop typing). Toggle on/off in settings; works alongside the periodic interval.
- **Resilient retries** — failed files are skipped, queued, and retried next sync with exponential backoff; a dropped Wi-Fi connection resumes automatically.
- **Standard WebDAV fallback** — works against any WebDAV server (recursive), Nextcloud features auto-disabled.
- **Debug mode (dry-run inspector)** — a settings toggle that turns **Sync Now** into a *preview only*: it lists every file with its local/remote paths and the action a real sync would take (upload / download / merge / delete), **without changing anything**. Click a file row to open a read-only before/after merge preview for that file. Watch mode is suspended while Debug mode is on. Turn it off to run real syncs again.

### Conflict safety (never lose content)
- **Content is never discarded** on conflict.
- **Inline conflict markers** (Git-style `<<<<<<< LOCAL` / `=======` / `>>>>>>> REMOTE`) written directly into the file.
- **Optional auto-merge** (`reconcile-text` / diff3) for edits in different regions — off by default; YAML frontmatter is never auto-merged.
- **Conflict badge** in the status bar showing the count of unresolved conflicts (clears to normal at zero; pairs well with a `#conflict` tag search).

### Nextcloud power features
- **Login Flow v2** — set up with a browser approval instead of manually issuing and pasting an app password. Credentials are stored in Obsidian's secret credentials store, **never in plain text** in `data.json`.
- **Server version history** — for the active note, list every revision the server holds (newest first) and restore any of them atomically, with confirmation. The restored content syncs back cleanly without triggering an infinite conflict loop.
- **Chunked upload** — large attachments (images, PDFs, audio) above the chunk threshold are split and uploaded resumably; interrupted uploads never publish a partial file, and completion is checksum-verified. A separate absolute `maxFileSizeMB` cap guards memory.
- **Files Locking** *(experimental, opt-in)* — acquires a per-file server lock immediately before each update and releases it right after, preventing concurrent-write conflicts from other clients (Nextcloud desktop/web). Stale locks from a crashed run are safely detected and released.

---

## Requirements

- **Obsidian** `1.12.7` or later (desktop / Electron). Mobile is out of scope for now.
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
5. Run the **Sync Now** command (or wait for the periodic sync). On the first run you'll get a **dry-run preview** (`N uploads / M downloads`) to approve.

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

- Desktop (Electron) only; **mobile** and **end-to-end encryption (E2EE)** are out of scope for this version.
- Designed primarily for Markdown / text Vaults; single files in the hundreds-of-MB range are beyond the v1 design target.
- Keep the Vault on local storage — don't double-manage it with another cloud sync (e.g. iCloud Drive) at the same time.
- Nextcloud-specific features require a compatible server version; older or non-Nextcloud servers transparently fall back to core WebDAV sync.

---

## Contributing & development

```bash
npm install      # install dependencies
npm run dev      # development build (watches and rebuilds main.js)
npm run build    # type-check + production build
npm test         # run the test suite
```

**Commit messages must be written in English.** Keep the subject in the imperative mood and explain the *why* in the body when it isn't obvious.

**Commits must be authored as `Daisuke ITO <siosig@gmail.com>`.** This author identity is fixed for the project; configure your local Git accordingly (e.g. `git commit --author="Daisuke ITO <siosig@gmail.com>"`).

Issues and pull requests are welcome.

---

## License

[MIT](LICENSE) © Daisuke ITO
