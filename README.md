# Nextcloud Sync for Obsidian

Bidirectional sync between your Obsidian Vault and Nextcloud — built **specifically for Nextcloud**, not just generic WebDAV.

Most "WebDAV sync" plugins treat the server as a dumb file store: they compare modification times, copy files, and hope for the best. **Nextcloud Sync** instead talks to Nextcloud's own APIs (Capabilities, file IDs, checksums, versions, locking, Login Flow v2) to make syncing *safe*, *fast*, and *frictionless* — while still degrading gracefully to plain WebDAV when those APIs aren't available.

> 日本語版は [`README.ja.md`](README.ja.md) を参照してください（下部に概要もあります）。

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
- **Trashbin deletes** — local deletions go to the system trash; remote deletions use the Nextcloud trashbin (recoverable).
- **Per-Vault configuration** — each Vault can target a different Nextcloud server / account without state bleeding between them.
- **Periodic auto-sync** with a configurable interval (set to `0` for manual-only), plus a **Sync Now** command.
- **Sync on file change (watch mode)** — optionally sync immediately after you edit a local Markdown file (debounced ~2s after you stop typing). Toggle on/off in settings; works alongside the periodic interval.
- **Resilient retries** — failed files are skipped, queued, and retried next sync with exponential backoff; a dropped Wi-Fi connection resumes automatically.
- **Standard WebDAV fallback** — works against any WebDAV server (recursive), Nextcloud features auto-disabled.

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
- **Nextcloud** Hub 26 "Winter" (`33.0.4`) or later for the Nextcloud-specific features. Older servers are warned at connect time; plain WebDAV servers fall back to core sync.
- A Nextcloud account. You can authenticate with **Login Flow v2** (recommended) or a manually issued **app password** (never your main password).

---

## Installation

### From the Community Plugins browser (recommended)
1. In Obsidian, open **Settings → Community plugins**.
2. Disable Restricted mode, click **Browse**, and search for **Nextcloud Sync**.
3. **Install**, then **Enable**.

### Manual installation
1. Download `main.js` and `manifest.json` (and `styles.css` if present) from the latest [GitHub Release](../../releases).
2. Copy them into `<YourVault>/.obsidian/plugins/obsidian-nextcloudsync/`.
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

## How it works (in brief)

On connect, the plugin probes `/status.php` (maintenance mode) and `/ocs/v1.php/cloud/capabilities` to learn the server version and which features (`checksums`, `files locking`, …) are available. It then maintains a **per-device state database** — a snapshot of every file's path, content hash, and remote file ID at the last successful sync. Each sync diffs the current state against that snapshot and the server's `sync-token`, transferring only what changed. Every Nextcloud-specific behavior is gated behind capability detection, so the same plugin works against a full Nextcloud Hub and a bare WebDAV server alike (**Progressive Enhancement**).

---

## Privacy & security

- App passwords / credentials are kept in Obsidian's **secret credentials store**, never written in plain text to `data.json`.
- Your **main account password is never used or stored** — only app passwords (issued manually or via Login Flow v2).
- All network traffic uses Obsidian's `requestUrl` API.
- The plugin's own folder (`.obsidian/plugins/obsidian-nextcloudsync/`) is excluded from sync.

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

Issues and pull requests are welcome.

---

## License

[MIT](LICENSE) © Daisuke ITO

---

## 概要（日本語）

**Nextcloud Sync** は、Obsidian Vault と Nextcloud を双方向同期するプラグインです。単なる WebDAV 同期とは異なり、**Nextcloud 固有の API を活用**して同期を安全・高速・簡単にします。

- **ハッシュベース差分同期** … 更新日時ではなく内容ハッシュ＋ Nextcloud の `sync-token` で判定。誤再アップロードがなく大規模 Vault でも高速。
- **ファイル ID（`OC-FileId`）でリネーム追跡** … 移動・改名を「削除＋新規」にせず履歴を保持。
- **ゴミ箱経由の削除** … Nextcloud のゴミ箱に入るため復元可能。
- **Login Flow v2** … ブラウザ承認だけでアプリパスワードを自動発行・保存（平文保存なし）。
- **サーバーバージョン履歴の閲覧・復元** … 誤編集を Obsidian 内から過去版へ復元。
- **チャンクアップロード** … 大容量ファイルを分割・再開可能・チェックサム検証付きで確実に同期。
- **Files Locking（実験的・任意）** … 更新中にサーバーロックを取得し、同時編集コンフリクトを未然に防止。
- **ファイル変更時の即時同期（ウォッチモード・任意）** … ローカル Markdown を編集すると自動で同期（編集が止まって約2秒後）。トグルで ON/OFF、定期同期と併用可。
- **コンフリクト時に内容を消さない** … インラインマーカー挿入＋任意の自動マージ（YAML フロントマターは対象外）。
- **Capability 検出による Progressive Enhancement** … 非 Nextcloud／標準 WebDAV サーバーでは Nextcloud 機能を自動無効化し、標準同期にフォールバック。

**動作要件**: Obsidian 1.12.7 以上（デスクトップ）、Nextcloud Hub 26 Winter（33.0.4）以上。モバイル・E2EE は対象外です。
