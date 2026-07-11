import { DataAdapter, FileView, Notice, Platform, TFile, Vault, Workspace, normalizePath } from 'obsidian';

export interface LocalFileEntry { path: string; size: number; mtime: number; }

// Atomic-write temp suffix. Kept short on purpose: the temp file lives in the SAME directory as its
// target, and a filesystem caps each path component at NAME_MAX bytes (255 on ext4/F2FS, i.e. Android
// internal storage). The temp NAME must not inherit the target's length, or a target that is itself
// within 255 bytes could still fail to write because `target + suffix` overflows (the FILE_NOTCREATED
// bug). See `tmpPathFor`. LEGACY_TMP_SUFFIX is only recognised (never produced) so stale temp files
// from older plugin versions are still ignored by the watcher and cleaned up.
const TMP_SUFFIX = '.ncs.tmp';
const LEGACY_TMP_SUFFIX = '.nextcloudsync.tmp';
const NAME_MAX_BYTES = 255;
const IGNORE_TIMEOUT_MS = 5000;

/** UTF-8 byte length (NAME_MAX is measured in bytes, not UTF-16 code units). */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Deterministic, non-cryptographic 32-bit FNV-1a hash → base36. Collision strength is irrelevant
 *  here: it only needs to make per-target temp names unique within a directory. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Temp path for an atomic write: a short, fixed-length hidden name in the target's OWN directory.
 * Because the name is derived from a hash (not the target name) it stays well within NAME_MAX even
 * when the target name is near the 255-byte limit, and being in the same directory keeps the final
 * rename atomic. Distinct targets get distinct temp names; the same target is stable across calls.
 */
export function tmpPathFor(targetPath: string): string {
  const lastSlash = targetPath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? targetPath.slice(0, lastSlash) : '';
  const tmpName = `.${shortHash(targetPath)}${TMP_SUFFIX}`;
  return dir ? `${dir}/${tmpName}` : tmpName;
}

/**
 * Translate a raw write error into an actionable one when the target's final name itself exceeds
 * NAME_MAX (unavoidable: the OS cannot store it). Other errors (e.g. write-back verification) pass
 * through unchanged so they are never masked. Reactive by design: only consulted from a catch block.
 */
function translateNameTooLong(err: unknown, targetPath: string): unknown {
  const name = targetPath.slice(targetPath.lastIndexOf('/') + 1);
  const bytes = utf8ByteLength(name);
  if (bytes > NAME_MAX_BYTES) {
    return new Error(
      `File name too long (${bytes} bytes / max ${NAME_MAX_BYTES} bytes): "${name}". Shorten the file name.`,
    );
  }
  return err;
}

/** True for this plugin's own atomic-write temp files (never user content). Matches the current
 *  suffix and the legacy one so older stray temp files remain recognised. */
export function isSyncTmpPath(path: string): boolean {
  return path.endsWith(TMP_SUFFIX) || path.endsWith(LEGACY_TMP_SUFFIX);
}

/**
 * Thin wrapper over Obsidian's `DataAdapter` for the plugin's local file IO. The Adapter API
 * (rather than the higher-level Vault API) is used deliberately: it gives the tmp-write → rename
 * atomicity the sync relies on, can address paths the Vault index does not track (the plugin's own
 * state / log files), and reads raw bytes for hashing and binary attachments — none of which the
 * `TFile`-based Vault API offers. All paths entering from the remote→local mapping are passed
 * through `normalizePath()` at the boundary for cross-platform safety.
 */
export class LocalAdapter {
  private ignoreList: Map<string, number> = new Map();

  constructor(
    private readonly adapter: DataAdapter,
    private readonly vault?: Vault,
    private readonly workspace?: Workspace,
  ) {}

  /**
   * The TFile currently displayed by any open leaf at `path`, or null if none (or no `workspace`
   * was injected, e.g. in unit tests). `FileView` is the common base for every file-backed view
   * (markdown, image, PDF, ...), so this covers both text and binary attachments uniformly.
   */
  private findOpenTFile(path: string): TFile | null {
    if (!this.workspace) return null;
    let found: TFile | null = null;
    this.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (view instanceof FileView && view.file?.path === path) found = view.file;
    });
    return found;
  }

  /** Register a path to be ignored for Vault events (prevents sync loop). */
  ignore(path: string): void {
    const existing = this.ignoreList.get(path);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => this.ignoreList.delete(path), IGNORE_TIMEOUT_MS);
    // In Node-based tests setTimeout returns a Timeout handle that keeps the process alive;
    // unref it so a pending ignore window can't block exit. No-op in Electron/the browser,
    // where window.setTimeout returns a number.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.ignoreList.set(path, timer);
  }

  /**
   * Returns true while the path is inside its ignore window. NOT consumed on read: one
   * atomicWrite fires several Vault events for the same path (create/delete/rename), so a
   * consume-on-first-event entry would let the later events leak through as user edits.
   * Entries expire via the timeout instead.
   */
  shouldIgnore(path: string): boolean {
    return this.ignoreList.has(path);
  }

  /**
   * Clear all pending ignore timers. Call from the plugin's onunload so a pending timer
   * can't fire after teardown and so timers don't leak across plugin reloads.
   */
  dispose(): void {
    for (const timer of this.ignoreList.values()) window.clearTimeout(timer);
    this.ignoreList.clear();
  }

  private async ensureParentDir(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash > 0) {
      const dir = filePath.slice(0, lastSlash);
      // Feature 046: mark the parent folder as our own write BEFORE creating it, so watch mode does
      // not pick up the resulting folder-create event and propagate a spurious MKCOL back to the
      // server (the folder already exists remotely — that is where the download came from). The
      // idempotent createSingleFolder is a second safety net if a deeper ancestor is missed here.
      this.ignore(dir);
      await this.adapter.mkdir(dir);
    }
  }

  /**
   * Write text content to `targetPath`. If the path is currently displayed by an open leaf
   * (issue #15: a background sync must not evict the user's open note), update it in place via
   * `Vault.modify` — a single write with no delete event, so Obsidian never detaches the leaf.
   * Otherwise fall back to the tmp-write → remove existing → rename atomicity below unchanged.
   */
  async atomicWrite(targetPath: string, content: string): Promise<void> {
    targetPath = normalizePath(targetPath);
    const openFile = this.findOpenTFile(targetPath);
    if (openFile) {
      this.ignore(targetPath);
      await this.vault!.modify(openFile, content);
      return;
    }
    const tmpPath = tmpPathFor(targetPath);
    this.ignore(tmpPath);
    this.ignore(targetPath);
    let targetRemoved = false;
    try {
      await this.ensureParentDir(targetPath);
      await this.adapter.write(tmpPath, content);
      if (await this.adapter.exists(targetPath)) {
        await this.adapter.remove(targetPath);
        targetRemoved = true;
      }
      await this.adapter.rename(tmpPath, targetPath);
    } catch (err) {
      // G4-1: if `remove(targetPath)` already succeeded before `rename` threw (mobile process kill /
      // Windows AV lock / external-storage blip mid-rename), tmpPath is the ONLY surviving copy of the
      // new content — neither the old file nor the new one is on disk at targetPath. Deleting tmp here
      // would destroy the sole copy outright. Only clean up tmp when the destructive remove() never
      // happened, i.e. tmp is still disposable scratch and the original target is untouched.
      if (!targetRemoved && await this.adapter.exists(tmpPath)) {
        await this.adapter.remove(tmpPath);
      }
      throw translateNameTooLong(err, targetPath);
    }
  }

  /**
   * Write binary content to `targetPath`. Same open-file in-place path as {@link atomicWrite}
   * (via `Vault.modifyBinary`), covering binary attachments (images, PDFs, ...) shown in a
   * non-markdown `FileView`. Falls back to the tmp-write → remove → rename atomicity (with its
   * read-back verification) when the path is not currently open.
   */
  async atomicWriteBinary(targetPath: string, data: ArrayBuffer): Promise<void> {
    targetPath = normalizePath(targetPath);
    const openFile = this.findOpenTFile(targetPath);
    if (openFile) {
      this.ignore(targetPath);
      await this.vault!.modifyBinary(openFile, data);
      return;
    }
    const tmpPath = tmpPathFor(targetPath);
    this.ignore(tmpPath);
    this.ignore(targetPath);
    let targetRemoved = false;
    try {
      await this.ensureParentDir(targetPath);
      await this.adapter.writeBinary(tmpPath, data);
      if (await this.adapter.exists(targetPath)) {
        await this.adapter.remove(targetPath);
        targetRemoved = true;
      }
      await this.adapter.rename(tmpPath, targetPath);
      // Read-back verification (spec 025, report §4.4): fsync is unavailable via the Obsidian adapter,
      // so confirm the file actually landed at the intended byte length. A truncated/empty write throws
      // here so the caller leaves Base unadvanced and re-syncs (self-heal) instead of recording a
      // corrupt download as converged.
      const written = await this.adapter.stat(targetPath);
      if (!written || written.size !== data.byteLength) {
        throw new Error(`write-back verification failed for ${targetPath}: expected ${data.byteLength} bytes, found ${written ? written.size : 'none'}`);
      }
    } catch (err) {
      // G4-1: see the matching comment in atomicWrite() — once remove(targetPath) has run, tmpPath may
      // be the only surviving copy of the new content, so it must not be deleted on a later failure
      // (e.g. a rename crash). If rename already succeeded and only the read-back check above failed,
      // tmpPath no longer exists (it was renamed away), so this guard is a no-op in that case.
      if (!targetRemoved && await this.adapter.exists(tmpPath)) {
        await this.adapter.remove(tmpPath);
      }
      throw translateNameTooLong(err, targetPath);
    }
  }

  async read(path: string): Promise<string> {
    return this.adapter.read(normalizePath(path));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(normalizePath(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path));
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    return this.adapter.stat(normalizePath(path));
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return this.adapter.list(normalizePath(path));
  }

  /**
   * Apply a specific mtime to a local file.
   * Desktop (Electron/Node.js): calls fs.utimes. Mobile or unavailable: silently skips.
   */
  async setMtime(path: string, mtime: number): Promise<void> {
    // Node's fs is desktop-only (Electron). On mobile this is a no-op; change detection is
    // hash-based, so a missing mtime does not affect sync correctness.
    if (!Platform.isDesktopApp) return;
    try {
      const nodefs = (window as Window & { require?: (m: string) => { utimes: (p: string, a: number, m: number, cb: (e: Error | null) => void) => void } }).require?.('fs');
      const getFullPath = (this.adapter as unknown as { getFullPath?: (p: string) => string }).getFullPath?.bind(this.adapter);
      if (!nodefs || !getFullPath) return;
      const fullPath = getFullPath(normalizePath(path));
      const sec = mtime / 1000;
      await new Promise<void>((resolve, reject) =>
        nodefs.utimes(fullPath, sec, sec, (err) => (err ? reject(err) : resolve())),
      );
    } catch { /* best-effort: silently ignore on mobile or unsupported environments */ }
  }

  /** Remove a tmp file only (never call remove on user files). */
  async removeTmp(tmpPath: string): Promise<void> {
    if (isSyncTmpPath(tmpPath) && await this.adapter.exists(tmpPath)) {
      await this.adapter.remove(tmpPath);
    }
  }

  showNotice(message: string, timeout = 4000): void {
    new Notice(message, timeout);
  }

  /**
   * Enumerate Vault-tracked files (path + cached stat) WITHOUT any native FS round-trip.
   * On mobile, adapter.list()/stat() each cross the JS↔native bridge; Vault.getFiles() and
   * TFile.stat are served from Obsidian's in-memory index. The config folder (.obsidian) is not
   * Vault-tracked and is intentionally excluded here — callers inject those paths separately.
   * Returns [] when no Vault was injected (used only by IO-level unit tests).
   */
  listVaultFiles(): LocalFileEntry[] {
    if (!this.vault) return [];
    return this.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
  }
}
