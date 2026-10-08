import { DataAdapter } from 'obsidian';
import { SyncFileOp, SyncHistoryDetail, SyncHistoryEntry } from '../types';

const TMP_SUFFIX = '.tmp';
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2000;

// Rolling 24h log of per-file sync outcomes for the status dialog; flushed once at session end.
export class SyncHistoryStore {
  private entries: SyncHistoryEntry[] = [];
  private readonly filePath: string;
  private readonly tmpPath: string;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: DataAdapter,
    pluginDir: string,
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {
    this.filePath = `${pluginDir}/sync-history.json`;
    this.tmpPath = this.filePath + TMP_SUFFIX;
  }

  async load(now: number = Date.now()): Promise<void> {
    try {
      let readPath = this.filePath;
      let recoveredFromTmp = false;
      if (!(await this.adapter.exists(readPath))) {
        // A crash between remove(filePath) and rename(tmpPath, filePath) leaves only tmp: recover from it.
        if (!(await this.adapter.exists(this.tmpPath))) return;
        readPath = this.tmpPath;
        recoveredFromTmp = true;
      }
      const raw = await this.adapter.read(readPath);
      const parsed = JSON.parse(raw) as unknown;
      this.entries = Array.isArray(parsed) ? (parsed as SyncHistoryEntry[]) : [];
      this.prune(now);
      if (recoveredFromTmp) {
        // Best-effort; the next save() recreates filePath from the recovered in-memory entries.
        await this.adapter.rename(this.tmpPath, this.filePath).catch(() => undefined);
      }
    } catch {
      console.warn('[SyncHistoryStore] Failed to parse history; starting empty');
      this.entries = [];
    }
  }

  // `message` is for errors only; `detail` carries optional checksum/size data for the sync log.
  record(
    path: string, op: SyncFileOp, at: number = Date.now(),
    message?: string, detail?: SyncHistoryDetail, runStartedAt?: number,
  ): void {
    const entry: SyncHistoryEntry = { path, op, at };
    if (message) entry.message = message;
    if (runStartedAt !== undefined) entry.runStartedAt = runStartedAt;
    if (detail) {
      if (detail.localHash !== undefined) entry.localHash = detail.localHash;
      if (detail.remoteId !== undefined) entry.remoteId = detail.remoteId;
      if (detail.remoteIdType !== undefined) entry.remoteIdType = detail.remoteIdType;
      if (detail.localSize !== undefined) entry.localSize = detail.localSize;
      if (detail.remoteSize !== undefined) entry.remoteSize = detail.remoteSize;
    }
    this.entries.push(entry);
  }

  recent(now: number = Date.now()): SyncHistoryEntry[] {
    const cutoff = now - this.windowMs;
    return this.entries.filter(e => e.at >= cutoff).sort((a, b) => b.at - a.at);
  }

  since(startedAt: number): SyncHistoryEntry[] {
    return this.entries.filter(e => e.at >= startedAt).sort((a, b) => a.at - b.at);
  }

  private prune(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    let kept = this.entries.filter(e => e.at >= cutoff);
    if (kept.length > this.maxEntries) {
      kept = kept.sort((a, b) => b.at - a.at).slice(0, this.maxEntries);
    }
    this.entries = kept;
  }

  save(now: number = Date.now()): Promise<void> {
    this.prune(now);
    const run = this.saveChain.then(() => this.doSave());
    this.saveChain = run.catch(() => {});
    return run;
  }

  private async doSave(): Promise<void> {
    const json = JSON.stringify(this.entries);
    await this.adapter.write(this.tmpPath, json);
    if (await this.adapter.exists(this.filePath)) {
      await this.adapter.remove(this.filePath);
    }
    await this.adapter.rename(this.tmpPath, this.filePath);
  }
}
