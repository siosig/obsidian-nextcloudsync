import { DataAdapter } from 'obsidian';
import { DirState, FileState, SyncState } from '../types';
import { AsyncMutex } from '../util/AsyncMutex';

const STATEDB_TMP_SUFFIX = '.tmp';
/** Trailing-debounce window for watch-mode coalesced saves (P0-B). */
const SAVE_DEBOUNCE_MS = 2000;

export class StateDB {
  private state: SyncState;
  private readonly statePath: string;
  private readonly tmpPath: string;
  /**
   * Single-Threaded Execution pattern: serialize the persist critical section so concurrent callers
   * (watch-mode single-file ops + full syncs under bounded parallelism) never interleave the
   * non-atomic exists→remove→rename sequence (which used to race into ENOENT). The mutex is the named,
   * separately-tested primitive replacing the former bespoke promise-chain.
   */
  private readonly saveMutex = new AsyncMutex();
  /**
   * O(1) reverse index: remoteFileId → path. Replaces the former Object.values().find() linear scan
   * in getFileByRemoteId (which became O(m²) during full-scan rename detection). Kept in sync by
   * setFile/deleteFile and rebuilt on load.
   */
  private fileIdIndex = new Map<string, string>();
  /** Pending trailing-debounce timer handle for watch-mode saves (P0-B); window.setTimeout returns a number. */
  private saveTimer: number | null = null;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly pluginDir: string,
    deviceId: string,
  ) {
    this.statePath = `${pluginDir}/state-${deviceId}.json`;
    this.tmpPath = this.statePath + STATEDB_TMP_SUFFIX;
    this.state = { deviceId, lastSyncTime: 0, syncToken: null, files: {}, directories: {} };
  }

  async load(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.statePath))) return;
      const raw = await this.adapter.read(this.statePath);
      const parsed = JSON.parse(raw) as SyncState;
      this.state = parsed;
      if (!this.state.directories) this.state.directories = {}; // pre-DP v1 state file
    } catch {
      // Corrupted DB — start fresh (recovery handled externally)
      console.warn('[StateDB] Failed to parse state DB; starting with empty state');
    }
    // A v1 state file simply lacks the optional signature fields (localMtime/localSize/remoteMtime);
    // it parses fine and the change-detection fast-path treats "signature missing" as "hash once,
    // then populate" — no migration step or version bump required.
    this.rebuildIndex();
  }

  /** Rebuild the remoteFileId → path index from the current state (called on load). */
  private rebuildIndex(): void {
    this.fileIdIndex.clear();
    for (const [path, fs] of Object.entries(this.state.files)) {
      if (fs.remoteFileId) this.fileIdIndex.set(fs.remoteFileId, path);
    }
  }

  /**
   * Atomically persist state to disk (tmp → rename). Concurrent callers are serialized:
   * the exists → remove → rename sequence is not atomic, so two interleaved saves used to
   * race each other into ENOENT on the unlink step.
   */
  save(): Promise<void> {
    return this.saveMutex.run(() => this.doSave());
  }

  /**
   * Coalesce frequent watch-mode single-file saves into one write via a trailing debounce. Many
   * rapid create/modify events therefore produce a single state write instead of one per file.
   * Crash-window: at most SAVE_DEBOUNCE_MS of un-persisted watch ops; the worst case is a bounded
   * re-check on the next sync (no corruption). Full syncs still call save() directly at session end
   * (after flush()), so a completed sync is always persisted immediately.
   */
  requestSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Force any pending debounced save to run now and await it (plus any in-flight save). Call before
   * a full-sync save and from the plugin's onunload so a coalesced update can never be lost.
   */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.save();
      return;
    }
    // No pending timer: queue an empty critical section so we return only once any in-flight save settled.
    await this.saveMutex.run(() => undefined);
  }

  private async doSave(): Promise<void> {
    // Compact serialization (no pretty-print): smaller payload + far less stringify CPU on large
    // vaults / mobile. The state file is machine-only, so human readability is not needed.
    const json = JSON.stringify(this.state);
    await this.adapter.write(this.tmpPath, json);
    if (await this.adapter.exists(this.statePath)) {
      await this.adapter.remove(this.statePath);
    }
    await this.adapter.rename(this.tmpPath, this.statePath);
  }

  getFile(path: string): FileState | undefined {
    return this.state.files[path];
  }

  /** O(1) lookup by Nextcloud remoteFileId (oc:fileid), backed by {@link fileIdIndex}. */
  getFileByRemoteId(remoteFileId: string): FileState | undefined {
    const path = this.fileIdIndex.get(remoteFileId);
    return path ? this.state.files[path] : undefined;
  }

  setFile(fileState: FileState): void {
    const prev = this.state.files[fileState.path];
    // Drop a stale index entry if this path's remoteFileId changed (e.g. re-create on the server).
    if (prev?.remoteFileId && prev.remoteFileId !== fileState.remoteFileId) {
      this.fileIdIndex.delete(prev.remoteFileId);
    }
    this.state.files[fileState.path] = fileState;
    if (fileState.remoteFileId) this.fileIdIndex.set(fileState.remoteFileId, fileState.path);
  }

  deleteFile(path: string): void {
    const prev = this.state.files[path];
    if (prev?.remoteFileId) this.fileIdIndex.delete(prev.remoteFileId);
    delete this.state.files[path];
  }

  getAllFiles(): FileState[] {
    return Object.values(this.state.files);
  }

  // ── Tracked directories (DP): first-class, contentless entities symmetric with files ──
  getDir(path: string): DirState | undefined {
    return this.state.directories?.[path];
  }

  setDir(dir: DirState): void {
    if (!this.state.directories) this.state.directories = {};
    this.state.directories[dir.path] = dir;
  }

  deleteDir(path: string): void {
    if (this.state.directories) delete this.state.directories[path];
  }

  getAllDirs(): DirState[] {
    return this.state.directories ? Object.values(this.state.directories) : [];
  }

  getSyncToken(): string | null {
    return this.state.syncToken;
  }

  setSyncToken(token: string | null): void {
    this.state.syncToken = token;
  }

  getLastSyncTime(): number {
    return this.state.lastSyncTime;
  }

  setLastSyncTime(time: number): void {
    this.state.lastSyncTime = time;
  }

  getDeviceId(): string {
    return this.state.deviceId;
  }

  /** Count files with isConflicted = true */
  countConflicted(): number {
    return Object.values(this.state.files).filter(f => f.isConflicted).length;
  }

  /** Full snapshot for testing / debug */
  snapshot(): SyncState {
    return JSON.parse(JSON.stringify(this.state)) as SyncState;
  }

  /**
   * Reset the tracking index ("Vault index") to its first-install empty state and persist it.
   * Clears every tracked file and the sync token so the next sync runs as a first-run sync. The
   * deviceId is preserved; no vault or remote file is touched (only this state file). Any pending
   * debounced save is cancelled first so it cannot resurrect the old state after the reset write.
   */
  async reset(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.state = { deviceId: this.state.deviceId, lastSyncTime: 0, syncToken: null, files: {} };
    this.fileIdIndex.clear();
    await this.save();
  }

  /**
   * Reset the on-disk tracking index without a live {@link StateDB} instance (used when the plugin
   * is unconfigured and no engine/StateDB has been constructed). Writes the canonical empty state
   * for the given device using the same atomic tmp → rename strategy as {@link doSave}.
   */
  static async resetFile(adapter: DataAdapter, pluginDir: string, deviceId: string): Promise<void> {
    const statePath = `${pluginDir}/state-${deviceId}.json`;
    const tmpPath = statePath + STATEDB_TMP_SUFFIX;
    const initial: SyncState = { deviceId, lastSyncTime: 0, syncToken: null, files: {} };
    await adapter.write(tmpPath, JSON.stringify(initial));
    if (await adapter.exists(statePath)) {
      await adapter.remove(statePath);
    }
    await adapter.rename(tmpPath, statePath);
  }
}
