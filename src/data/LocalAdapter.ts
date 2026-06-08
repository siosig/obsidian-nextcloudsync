import { DataAdapter, Notice } from 'obsidian';

const TMP_SUFFIX = '.nextcloudsync.tmp';
const IGNORE_TIMEOUT_MS = 5000;

export class LocalAdapter {
  private ignoreList: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(private readonly adapter: DataAdapter) {}

  /** Register a path to be ignored for Vault events (prevents sync loop). */
  ignore(path: string): void {
    const existing = this.ignoreList.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => this.ignoreList.delete(path), IGNORE_TIMEOUT_MS);
    this.ignoreList.set(path, timer);
  }

  /** Check and consume an ignore entry. Returns true if the path should be skipped. */
  shouldIgnore(path: string): boolean {
    if (this.ignoreList.has(path)) {
      clearTimeout(this.ignoreList.get(path)!);
      this.ignoreList.delete(path);
      return true;
    }
    return false;
  }

  /** Atomically write text content: write to tmp → remove existing → rename. */
  async atomicWrite(targetPath: string, content: string): Promise<void> {
    const tmpPath = targetPath + TMP_SUFFIX;
    this.ignore(tmpPath);
    this.ignore(targetPath);
    try {
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
