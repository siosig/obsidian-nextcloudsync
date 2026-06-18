import { DataAdapter } from 'obsidian';
import { SyncFileOp, SyncHistoryDetail, SyncHistoryEntry } from '../types';

const TMP_SUFFIX = '.tmp';
/** Rolling retention window: entries older than this are dropped. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
/** Hard cap on stored entries to bound the on-disk file for large vaults. */
const DEFAULT_MAX_ENTRIES = 2000;

/**
 * Persisted, time-pruned log of per-file sync outcomes (uploaded / downloaded / deleted /
 * conflict / error). Backs the "recent activity" section of the sync status dialog so the user
 * can see what synced — including successes — within the last 24 hours, across restarts.
 *
 * Storage mirrors StateDB: atomic tmp→rename writes, serialized save chain, corruption-tolerant
 * load. Records are held in memory during a sync and flushed once at session end.
 */
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
      if (!(await this.adapter.exists(this.filePath))) return;
      const raw = await this.adapter.read(this.filePath);
      const parsed = JSON.parse(raw) as unknown;
      this.entries = Array.isArray(parsed) ? (parsed as SyncHistoryEntry[]) : [];
      this.prune(now);
    } catch {
      console.warn('[SyncHistoryStore] Failed to parse history; starting empty');
      this.entries = [];
    }
  }

  /**
   * Record one file outcome. Held in memory until save(). `message` is for errors only.
   * `detail` carries optional checksum/size data for the sync log; only defined fields are stored.
   */
  record(
    path: string, op: SyncFileOp, at: number = Date.now(),
    message?: string, detail?: SyncHistoryDetail,
  ): void {
    const entry: SyncHistoryEntry = { path, op, at };
    if (message) entry.message = message;
    if (detail) {
      if (detail.localHash !== undefined) entry.localHash = detail.localHash;
      if (detail.remoteId !== undefined) entry.remoteId = detail.remoteId;
      if (detail.remoteIdType !== undefined) entry.remoteIdType = detail.remoteIdType;
      if (detail.localSize !== undefined) entry.localSize = detail.localSize;
      if (detail.remoteSize !== undefined) entry.remoteSize = detail.remoteSize;
    }
    this.entries.push(entry);
  }

  /** Entries within the rolling window, newest first. */
  recent(now: number = Date.now()): SyncHistoryEntry[] {
    const cutoff = now - this.windowMs;
    return this.entries.filter(e => e.at >= cutoff).sort((a, b) => b.at - a.at);
  }

  /** Entries recorded at or after `startedAt`, in chronological (sync) order — one sync session. */
  since(startedAt: number): SyncHistoryEntry[] {
    return this.entries.filter(e => e.at >= startedAt).sort((a, b) => a.at - b.at);
  }

  /** Drop entries older than the window, then cap total count keeping the newest. */
  private prune(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    let kept = this.entries.filter(e => e.at >= cutoff);
    if (kept.length > this.maxEntries) {
      kept = kept.sort((a, b) => b.at - a.at).slice(0, this.maxEntries);
    }
    this.entries = kept;
  }

  /** Atomically persist (tmp → rename), pruning first. Serialized like StateDB.save(). */
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
