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

> ⚠️ **Heads-up: settings are being streamlined.** Over the next few days, options with little practical value will be progressively removed so the plugin stays simple and hard to misconfigure. Sensible behaviour is derived automatically instead. If a setting you used to see is gone, that is intentional — the plugin now picks the right value for you.

---

## What's new in this release (0.7.21-beta.3)

- **Frontmatter merges no longer corrupt notes or pile up tags (0.7.21-beta.3)** — the frontmatter (YAML properties) part of a conflict is now resolved as structured data, never as text. Conflict markers (`<<<<<<<` / `>>>>>>>`) can no longer land inside a note's `---` block (which used to break Obsidian's Properties and re-nest on the next sync), and list fields (tags, aliases, related) merge as a true 3‑way set: a tag deleted on one device is now actually removed instead of resurrecting, near‑duplicate spellings (`#tag` vs `tag`) collapse to one, and out‑of‑band changes made by server‑side tools propagate correctly.
- **"Use remote" / "Use local" recover a real clean version (0.7.21-beta.3)** — when a text conflict wrote merge markers into a note, force‑resolving it from the Sync status dialog used to just re‑sync the marker‑filled content while clearing the warning. Now the plugin snapshots both clean sides at conflict time, so "Use remote", "Use local", "Latest modified" and "Biggest size" restore a genuine marker‑free version and only clear the conflict once the note is actually clean. No new settings.

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
| Concurrent edits | Hope nobody else writes | **Optimistic concurrency** — every update carries an `If-Match` precondition, so a remote changed by another device is turned into a conflict (no lost update) without locking round trips |
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
- **Excluded folders** — register Vault-relative folders that are never synced (neither uploaded nor downloaded, and never created on the server). Useful for version-control or tooling folders such as `.git`, and for large media you keep device-local. Matching is a folder-prefix match at a folder boundary, so `Attachments` excludes `Attachments/` and everything under it but not `Attachments-old`. Add or remove entries under **Settings → Excluded folders** (type a path or use the folder picker). Dotfolders (`.git`, the config-folder `plugins/`, the plugin's own state) are already excluded automatically; this list is an additive layer on top.
- **Periodic auto-sync** with a configurable interval (set to `0` for manual-only), plus a **Sync now** command.
- **Sync on file change (watch mode)** — optionally sync immediately after you edit a local file (debounced ~2s after you stop typing). Toggle on/off in settings; works alongside the periodic interval.
- **Resilient retries** — failed files are skipped, queued, and retried next sync with exponential backoff; a dropped Wi-Fi connection resumes automatically.
- **Standard WebDAV fallback** — works against any WebDAV server (recursive), Nextcloud features auto-disabled.
- **Filter the sync-status dialog by status** — the status dialog has a checkbox row (Uploaded, Downloaded, Deleted, Merged, Conflicted, Local wins, Remote wins, Error) so you can focus on, say, only conflicts. All on by default; your selection is saved and persists across Obsidian restarts, and applies to every section.
- **Compare a file with its remote version** — right-click any file in the explorer (on mobile: long-press, or run the *Compare with remote* command) to open a popup comparing local vs remote modification time, checksum (with a match/mismatch badge), and a line diff. On narrow screens the diff stacks vertically. Resolve the difference right there with **push** (overwrite remote with local) or **pull** (overwrite local with remote), each behind a confirmation.
- **Per-device logging** — two opt-in logs, written to a folder you pick (a fuzzy folder picker; defaults to the vault root) and named per device so multiple devices never overwrite one another:
  - **Sync log** (`nextcloud-sync_sync_<device>.txt`) — one appended block per sync with the plugin version and all merge-related settings in the header, then one line per operation showing the marker, path, local/remote checksums and sizes. A level switch records *important events only* (conflicts, merges, side-wins, errors) or *all operations*.
  - **Debug log** (`nextcloud-sync_debug_<device>.txt`) — a timestamped diagnostic log with selectable verbosity (error / debug / verbose), the plugin version, and a snapshot of all settings. Useful for troubleshooting on mobile where there's no console. Turn it off and delete the file when finished.
- **Reset the Vault index** *(Settings → Maintenance)* — clear this device's sync tracking index back to its first-install state (behind a confirmation) so the next sync re-scans everything. No Vault or remote files are deleted; use it to recover from inconsistent sync state.

### Conflict safety (never lose content)
- **A strategy per file type.** You pick **which extensions are "auto merge files"** (markdown, text and common code extensions by default) and a conflict strategy for each side: an **Auto merge file strategy** and an **Other file strategy** (everything else — images, PDFs, config JSON). Every conflict is always decided — there is no hold/error mode.
- **Merge** (`reconcile-text` / diff3, the default for auto merge files) integrates edits in different regions, including YAML frontmatter when the two sides changed non-overlapping lines. A text conflict is written as conflict markers; a non-text file is left untouched and flagged (never corrupted with markers).
- **Deterministic strategies** for anything else: **Latest modified** (keep the newer side — the default for other files), **Biggest size** (keep the larger), **Local wins**, or **Remote wins**. A size/mtime tie is left untouched and re-evaluated on the next sync. Keep Nextcloud version history on so an overwritten side is recoverable; *Compare with remote* lets you resolve any file by hand.
- **Conflict badge** in the status bar showing the count of unresolved conflicts (clears to normal at zero; pairs well with a `#conflict` tag search).

### Nextcloud power features
- **Login Flow v2** — set up with a browser approval instead of manually issuing and pasting an app password. Credentials are stored in Obsidian's secret credentials store, **never in plain text** in `data.json`.
- **Server version history** — for the active note, list every revision the server holds (newest first) and restore any of them atomically, with confirmation. The restored content syncs back cleanly without triggering an infinite conflict loop.
- **Chunked upload** — large attachments (images, PDFs, audio) above the chunk threshold are split and uploaded resumably; interrupted uploads never publish a partial file, and completion is checksum-verified. A separate absolute `maxFileSizeMB` cap guards memory in **both directions** — oversized files are skipped on upload *and* on download (the download size is taken from the server's PROPFIND, so the body is never fetched).
- **Lost-update safety without locking** — every update carries an always-on `If-Match` precondition: a remote changed by another client returns 412, which the engine turns into a conflict (download remote + resolve). This replaces per-file WebDAV LOCK/UNLOCK round trips, so server-side file locking is intentionally never used.

---

## Mobile (iOS / Android)

Mobile is supported, with a few platform-aware differences (desktop behaviour is unchanged):

- **Automatic sync is off by default on mobile.** The OS suspends background timers, so periodic auto-sync and "sync on file change" are disabled (greyed out). Use **Sync now**, or rely on **Sync on startup**, which is on by default on every platform (since 0.7.11) and syncs once a few seconds after the app opens.
- **Large files are skipped on mobile** in **both directions (upload and download)** above the "Maximum file size" limit (set `0` for unlimited) to avoid out-of-memory crashes; skips are reported.
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
4. (Optional) Adjust the auto-sync interval, **Sync on file change** (watch mode), and auto-merge options.
5. Run the **Sync now** command (or wait for the periodic sync). The first run performs a full scan of your Vault and the remote, then transfers what's needed; subsequent syncs are incremental.

Your Vault is synced into a folder named after the Vault on the Nextcloud side, keeping multiple Vaults cleanly separated.

---

## FAQ

**Can I use a scoped Nextcloud Public Link Share instead of granting full account access?**

Yes. If you'd rather not hand the plugin an app password with full account access, you can share a single directory as a **Public Link Share with username/password** on the Nextcloud side, then point the plugin at it:

- **Server URL:** `https://<host>/public.php/webdav/`
- **Username:** the share token (the part of the share link after `/s/`)
- **App password:** the share's password

One point of confusion here: when you click **Link…** to store the app password, you're asked for an **ID** and a **value**. The **ID is a local storage key inside Obsidian's encrypted Secret Storage — it is never sent to the server**, so it can be anything (e.g. `default`); it's restricted to lowercase letters/digits/dashes because that's an Obsidian platform constraint, not something this plugin controls. The actual share password goes in the **value**, which accepts any characters. Put the share token in the **Username** field, not in the ID field.

Note: version history / restore and chunked upload are optional convenience features layered on top of core sync; they haven't been verified against Public Link Share endpoints and may not work there. Basic upload/download sync is unaffected.

---

## Enabling Nextcloud server-side features

One power feature depends on a server-side Nextcloud app. It only needs to be enabled **once by a Nextcloud administrator**. The plugin detects it through the capabilities API — if the app is missing, the feature simply stays inactive (no error).

> **Lost-update safety needs no setting.** The plugin always sends an `If-Match` precondition on upload, so a file changed on the server by another client is turned into a conflict instead of being silently overwritten — there is no File Locking toggle to configure.

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
- **Request timeouts** — for large vaults or big files, increase PHP `max_execution_time` and php-fpm / web-server timeouts (e.g. nginx `fastcgi_read_timeout`). The plugin uses a fixed 30-second network timeout.
- **Brute-force protection** — Nextcloud throttles repeated requests from one IP and can return HTTP 429, especially when several devices sync from the same network or after auth errors. If you hit this, whitelist the network in **Administration settings → Security**, or set `auth.bruteforce.protection.enabled`/the IP allow-list in `config.php`.
- **Background jobs (cron)** — configure Nextcloud's recommended **Cron** background-job mode so version cleanup and other maintenance run reliably.
- **App passwords & two-factor auth** — never use your main account password; if 2FA is enabled an app password is mandatory. Login Flow v2 issues one for you automatically.
- **Checksums (optional, recommended)** — the plugin prefers Nextcloud's `oc:checksums` (SHA-256) for change detection and automatically falls back to ETag when they aren't present, so no configuration is required; leaving Nextcloud's default checksum support enabled gives the most accurate detection.

---

## Settings defaults

The settings screen is intentionally minimal: only Server URL, sign-in, Sync folder,
Sync interval, Wi-Fi only, Excluded folders, the config-folder toggles, and an
*Enable logging* switch are shown. Every other option was removed and is now a fixed
value or derived automatically from your platform. They are documented here so you
always know what the plugin is doing.

### Editable settings (initial values)

These are the options you can change. Most start the same on both platforms; a few differ on first run.

| Setting | Desktop | Mobile |
|---|---|---|
| Server URL / Username / App password | empty | empty |
| Sync interval | 15 min | 15 min (disabled — use *Sync now* or *Sync on startup*) |
| Sync on Wi-Fi only | off | on |
| Sync config folder (master) | off | off |
| └ Bookmarks / Other settings | on / on | on / on |
| Auto merge file types | md, txt, cpp, py, c, h, hpp, rs, go, ts, js, java, sh | same |
| Auto merge file strategy | Merge | Merge |
| Other file strategy | Latest modified | Latest modified |
| Enable logging | off | off |
| Excluded folders | empty | empty |

> The config-folder category toggles (Bookmarks, Other settings) only take effect once the master *Sync config folder* is on.

### Fixed values (all platforms)

| Setting | Value |
|---|---|
| Network timeout | 30 seconds |
| Startup sync delay | 1 second (`0` = no startup sync) |
| Chunk threshold | 50 MB (desktop) / 20 MB (mobile) |
| Chunked upload | on |
| Bulk upload | on |
| File locking | off — `If-Match` preconditions provide lost-update safety |
| Max conflict regions | 0 (no region-count fallback) |
| Compare with remote | on (desktop and mobile) |
| Log folder | vault root |
| Device name | auto (`<platform>-<deviceId>`) |

### Platform-derived values

| Setting | Desktop | Mobile |
|---|---|---|
| Sync on file change | on | off |
| Maximum file size | unlimited (`0`) | 20 MB |
| Network concurrency | auto from RAM (≈ 16 on 8 GB+) | ≈ 3 |

---

## How it works (in brief)

On connect, the plugin probes `/status.php` (maintenance mode) and `/ocs/v1.php/cloud/capabilities` to learn the server version and which features (`checksums`, `files locking`, …) are available. It then maintains a **per-device state database** — a snapshot of every file's path, content hash, and remote file ID at the last successful sync. Each sync diffs the current state against that snapshot and the server's `sync-token`, transferring only what changed. Every Nextcloud-specific behavior is gated behind capability detection, so the same plugin works against a full Nextcloud Hub and a bare WebDAV server alike (**Progressive Enhancement**).

---

## Testing & reliability

Sync correctness is guarded by an extensive automated test suite: **hundreds of fast pure-logic tests** (run on every change) plus **live end-to-end suites that drive two devices against a real Nextcloud server**, including exhaustive option-combination matrices for conflict resolution and multi-device convergence.

These tests exist specifically to prevent sync-inconsistency states — **data loss, endless re-uploading/re-downloading, a remote change that never reaches the local copy, or a local change that never reaches the remote**. Even so, no test suite can cover every possible case, and unintended behavior can never be entirely ruled out. **If you ever run into such a situation, please don't hesitate to [open an issue](https://github.com/siosig/obsidian-nextcloudsync/issues) — it will be addressed as quickly as possible.**

---

## Privacy & security

- **This plugin collects no telemetry whatsoever.** No usage data, analytics, or crash reports are gathered or sent anywhere; the only network traffic is the sync between your vault and your own Nextcloud/WebDAV server.
- App passwords / credentials are kept in Obsidian's **secret credentials store**, never written in plain text to `data.json`.
- Your **main account password is never used or stored** — only app passwords (issued manually or via Login Flow v2).
- All network traffic uses Obsidian's `requestUrl` API.
- The Obsidian config folder (`.obsidian/`) is excluded from sync by default — only your notes and other vault files are synced. You can opt in to syncing selected parts of it via **Sync config folder** (see below). **Community plugins (`.obsidian/plugins/`) and the plugin's own sync-state database are never synced**, regardless of settings — they hold executable code and device-specific state, which is unsafe to overwrite across devices.

---

## Limitations

- **End-to-end encryption (E2EE)** relies on the HTTPS transport layer; the plugin does not add a redundant encryption layer of its own. This is a deliberate trade-off favouring maximum transport security and performance.
- **Config folder sync is opt-in.** Enable **Sync config folder** in settings to sync `.obsidian/` config across devices, chosen with two toggles: **Bookmarks** and **Other settings** (appearance, themes & snippets, hotkeys, and core-plugin settings). **Community plugins and the plugin's own sync-state database are never synced** (executable code / device-specific state). A synced change to core-plugin settings may require an Obsidian restart on the other device to take effect.
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
