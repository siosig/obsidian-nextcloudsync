import { DataAdapter, Notice, Platform, Vault, normalizePath } from 'obsidian';

export interface LocalFileEntry { path: string; size: number; mtime: number; }

const TMP_SUFFIX = '.nextcloudsync.tmp';
const IGNORE_TIMEOUT_MS = 5000;

/** True for this plugin's own atomic-write temp files (never user content). */
export function isSyncTmpPath(path: string): boolean {
  return path.endsWith(TMP_SUFFIX);
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

  constructor(private readonly adapter: DataAdapter, private readonly vault?: Vault) {}

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
    if (lastSlash > 0) await this.adapter.mkdir(filePath.slice(0, lastSlash));
  }

  /** Atomically write text content: write to tmp → remove existing → rename. */
  async atomicWrite(targetPath: string, content: string): Promise<void> {
    targetPath = normalizePath(targetPath);
    const tmpPath = targetPath + TMP_SUFFIX;
    this.ignore(tmpPath);
    this.ignore(targetPath);
    try {
      await this.ensureParentDir(targetPath);
      await this.adapter.write(tmpPath, content);
      if (await this.adapter.exists(targetPath)) {
        await this.adapter.remove(targetPath);
      }
      await this.adapter.rename(tmpPath, targetPath);
    } catch (err) {
      if (await this.adapter.exists(tmpPath)) {
        await this.adapter.remove(tmpPath);
      }
      throw err;
    }
  }

  /** Atomically write binary content: write to tmp → remove existing → rename. */
  async atomicWriteBinary(targetPath: string, data: ArrayBuffer): Promise<void> {
    targetPath = normalizePath(targetPath);
    const tmpPath = targetPath + TMP_SUFFIX;
    this.ignore(tmpPath);
    this.ignore(targetPath);
    try {
      await this.ensureParentDir(targetPath);
      await this.adapter.writeBinary(tmpPath, data);
      if (await this.adapter.exists(targetPath)) {
        await this.adapter.remove(targetPath);
      }
      await this.adapter.rename(tmpPath, targetPath);
    } catch (err) {
      if (await this.adapter.exists(tmpPath)) {
        await this.adapter.remove(tmpPath);
      }
      throw err;
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
    if (tmpPath.endsWith(TMP_SUFFIX) && await this.adapter.exists(tmpPath)) {
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
