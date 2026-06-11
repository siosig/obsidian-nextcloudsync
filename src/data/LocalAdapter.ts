import { DataAdapter, Notice, Platform } from 'obsidian';

const TMP_SUFFIX = '.nextcloudsync.tmp';
const IGNORE_TIMEOUT_MS = 5000;

/** True for this plugin's own atomic-write temp files (never user content). */
export function isSyncTmpPath(path: string): boolean {
  return path.endsWith(TMP_SUFFIX);
}

export class LocalAdapter {
  private ignoreList: Map<string, number> = new Map();

  constructor(private readonly adapter: DataAdapter) {}

  /** Register a path to be ignored for Vault events (prevents sync loop). */
  ignore(path: string): void {
    const existing = this.ignoreList.get(path);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => this.ignoreList.delete(path), IGNORE_TIMEOUT_MS);
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

  private async ensureParentDir(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash > 0) await this.adapter.mkdir(filePath.slice(0, lastSlash));
  }

  /** Atomically write text content: write to tmp → remove existing → rename. */
  async atomicWrite(targetPath: string, content: string): Promise<void> {
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
    return this.adapter.read(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    return this.adapter.stat(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return this.adapter.list(path);
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
      const fullPath = getFullPath(path);
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
}
