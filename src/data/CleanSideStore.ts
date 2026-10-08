import { DataAdapter } from 'obsidian';
import { AsyncMutex } from '../util/AsyncMutex';
import { CleanSideSnapshot } from '../types';

const TMP_SUFFIX = '.tmp';
const SAVE_DEBOUNCE_MS = 2000;

// The two clean sides of each marker-conflicted note. resolveByWrite writes markers locally and remotely, so both clean
// sides would be lost; capturing them at conflict time lets force-resolution restore a real clean version.
// Own file, not StateDB (two full bodies per conflicted file would bloat its saves). Entries are dropped at every
// convergence/resolution point; a corrupt store loads empty.
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
      let readPath = this.storePath;
      let recoveredFromTmp = false;
      if (!(await this.adapter.exists(readPath))) {
        // A crash between remove(storePath) and rename(tmpPath, storePath) leaves only tmp: recover from it.
        if (!(await this.adapter.exists(this.tmpPath))) return;
        readPath = this.tmpPath;
        recoveredFromTmp = true;
      }
      const raw = await this.adapter.read(readPath);
      const parsed = JSON.parse(raw) as Record<string, CleanSideSnapshot>;
      if (parsed && typeof parsed === 'object') this.snapshots = parsed;
      if (recoveredFromTmp) {
        // Best-effort; the next save() recreates storePath from the in-memory snapshots.
        await this.adapter.rename(this.tmpPath, this.storePath).catch(() => undefined);
      }
    } catch {
      // Corrupted store: start empty; snapshots re-capture at the next conflict.
      console.warn('[CleanSideStore] Failed to parse clean-side store; starting empty');
    }
  }

  get(path: string): CleanSideSnapshot | undefined {
    return this.snapshots[path];
  }

  set(path: string, snapshot: CleanSideSnapshot): void {
    this.snapshots[path] = snapshot;
  }

  delete(path: string): void {
    delete this.snapshots[path];
  }

  size(): number {
    return Object.keys(this.snapshots).length;
  }

  paths(): string[] {
    return Object.keys(this.snapshots);
  }

  // Serialized so concurrent saves never race the unlink step.
  save(): Promise<void> {
    return this.saveMutex.run(() => this.doSave());
  }

  requestSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

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
