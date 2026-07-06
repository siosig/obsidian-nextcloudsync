import { DataAdapter } from 'obsidian';
import { AsyncMutex } from '../util/AsyncMutex';

const TMP_SUFFIX = '.tmp';
/** Trailing-debounce window for coalesced saves (mirrors StateDB). */
const SAVE_DEBOUNCE_MS = 2000;

/**
 * Persistent store of the last-synced body of each Auto Merge File, used as the common ancestor
 * (base) for 3-way conflict merges (feature 038). Without a real base, reconcile-text duplicates the
 * blocks both sides share, so the merged file grows on every conflict. Keeping the last converged
 * body lets handleConflict pass a true base, eliminating the duplication.
 *
 * Stored in its OWN file (`merge-base-<deviceId>.json`), NOT in StateDB: StateDB is a high-churn
 * metadata store keyed per file (hashes/sizes/mtimes); folding bodies into it would bloat it and slow
 * every save. This store holds only Auto-Merge-File text bodies and updates only at convergence
 * points, so a separate, similarly-persisted (tmp→rename + debounce + flush) file is cleaner.
 *
 * The base is a quality hint, never the correctness backstop: if it is missing or stale (migration,
 * crash, rename) the merge falls back to base='' and feature 037's expansion guard prevents a
 * corrupt write; the next convergence re-seeds it (self-healing).
 */
export class MergeBaseStore {
  private bases: Record<string, string> = {};
  private readonly storePath: string;
  private readonly tmpPath: string;
  private readonly saveMutex = new AsyncMutex();
  private saveTimer: number | null = null;

  constructor(
    private readonly adapter: DataAdapter,
    pluginDir: string,
    deviceId: string,
  ) {
    this.storePath = `${pluginDir}/merge-base-${deviceId}.json`;
    this.tmpPath = this.storePath + TMP_SUFFIX;
  }

  async load(): Promise<void> {
    try {
      let readPath = this.storePath;
      let recoveredFromTmp = false;
      if (!(await this.adapter.exists(readPath))) {
        // G4-2: a crash between remove(storePath) and rename(tmpPath, storePath) in doSave leaves
        // storePath absent while tmpPath still holds the fully-written new data. Recover from tmp
        // instead of silently treating this as "no bases yet".
        if (!(await this.adapter.exists(this.tmpPath))) return;
        readPath = this.tmpPath;
        recoveredFromTmp = true;
      }
      const raw = await this.adapter.read(readPath);
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (parsed && typeof parsed === 'object') this.bases = parsed;
      if (recoveredFromTmp) {
        // Adopt the recovered tmp as the primary file; best-effort (the next save() recreates
        // storePath from the now-recovered in-memory bases if this rename also fails).
        await this.adapter.rename(this.tmpPath, this.storePath).catch(() => undefined);
      }
    } catch {
      // Corrupted store — start empty. Bases re-seed at the next convergence (self-healing).
      console.warn('[MergeBaseStore] Failed to parse merge-base store; starting empty');
    }
  }

  /** The stored common-ancestor body for `path`, or undefined when none is known. */
  get(path: string): string | undefined {
    return this.bases[path];
  }

  /** Record the last-synced body for `path`. Callers gate this on Auto Merge File classification. */
  set(path: string, body: string): void {
    this.bases[path] = body;
  }

  /** Drop the base for `path` (on file deletion) so it does not leak. */
  delete(path: string): void {
    delete this.bases[path];
  }

  /** Atomically persist (tmp → rename), serialized so concurrent saves never race the unlink step. */
  save(): Promise<void> {
    return this.saveMutex.run(() => this.doSave());
  }

  /** Coalesce frequent convergence saves into one write via a trailing debounce. */
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
    const json = JSON.stringify(this.bases);
    await this.adapter.write(this.tmpPath, json);
    if (await this.adapter.exists(this.storePath)) {
      await this.adapter.remove(this.storePath);
    }
    await this.adapter.rename(this.tmpPath, this.storePath);
  }
}
