import { DataAdapter } from 'obsidian';
import { AsyncMutex } from '../util/AsyncMutex';
import { CleanSideSnapshot } from '../types';

const TMP_SUFFIX = '.tmp';
/** Trailing-debounce window for coalesced saves (mirrors StateDB / MergeBaseStore). */
const SAVE_DEBOUNCE_MS = 2000;

/**
 * Persistent store of the two CLEAN sides of each currently marker-conflicted note (feature 044).
 *
 * When a text merge conflicts, `resolveByWrite` writes conflict markers locally AND uploads them, so
 * both local and remote end up holding the marker content and BOTH original clean sides are lost.
 * Force-resolution ("Use remote" / "Use local" / "Latest" / "Biggest") then has nothing clean to
 * recover. This store captures the local pre-merge body and the remote body at conflict-detection
 * time, keyed by path, so force-resolution can restore a real clean version.
 *
 * Stored in its OWN file (`conflict-clean-<deviceId>.json`), NOT in StateDB: StateDB is a high-churn
 * per-file metadata store (hashes/sizes/mtimes); folding two full bodies per conflicted file into it
 * would bloat and slow every save. This mirrors the feature-038 MergeBaseStore rationale and shape
 * (tmp→rename + debounce + flush), but holds the TWO divergent clean sides (not one converged base).
 *
 * Bounded to currently-conflicted files: entries are dropped at every convergence/resolution point
 * (self-healing). A corrupt store loads empty and re-captures on the next conflict.
 */
export class CleanSideStore {
  private snapshots: Record<string, CleanSideSnapshot> = {};
  private readonly storePath: string;
  private readonly tmpPath: string;
  private readonly saveMutex = new AsyncMutex();
  private saveTimer: number | null = null;

  constructor(
    private readonly adapter: DataAdapter,
    pluginDir: string,
    deviceId: string,
  ) {
    this.storePath = `${pluginDir}/conflict-clean-${deviceId}.json`;
    this.tmpPath = this.storePath + TMP_SUFFIX;
  }

  async load(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.storePath))) return;
      const raw = await this.adapter.read(this.storePath);
      const parsed = JSON.parse(raw) as Record<string, CleanSideSnapshot>;
      if (parsed && typeof parsed === 'object') this.snapshots = parsed;
    } catch {
      // Corrupted store — start empty. Snapshots re-capture at the next conflict (self-healing).
      console.warn('[CleanSideStore] Failed to parse clean-side store; starting empty');
    }
  }

  /** The captured clean sides for `path`, or undefined when none is known. */
  get(path: string): CleanSideSnapshot | undefined {
    return this.snapshots[path];
  }

  /** Record/replace the two clean sides for `path`. Callers gate this on the marker-write path. */
  set(path: string, snapshot: CleanSideSnapshot): void {
    this.snapshots[path] = snapshot;
  }

  /** Drop the snapshot for `path` (on resolution / convergence / deletion) so it does not leak. */
  delete(path: string): void {
    delete this.snapshots[path];
  }

  /** Number of stored snapshots — equals the count of currently marker-conflicted files at rest. */
  size(): number {
    return Object.keys(this.snapshots).length;
  }

  /** All paths with a stored snapshot (for the end-of-sync self-healing sweep). */
  paths(): string[] {
    return Object.keys(this.snapshots);
  }

  /** Atomically persist (tmp → rename), serialized so concurrent saves never race the unlink step. */
  save(): Promise<void> {
    return this.saveMutex.run(() => this.doSave());
  }

  /** Coalesce frequent saves into one write via a trailing debounce. */
  requestSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Flush any pending debounced save and await it (call before a full-sync save and on unload). */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.save();
      return;
    }
    await this.saveMutex.run(() => undefined);
  }

  private async doSave(): Promise<void> {
    const json = JSON.stringify(this.snapshots);
    await this.adapter.write(this.tmpPath, json);
    if (await this.adapter.exists(this.storePath)) {
      await this.adapter.remove(this.storePath);
    }
    await this.adapter.rename(this.tmpPath, this.storePath);
  }
}
