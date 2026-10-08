import { DataAdapter } from 'obsidian';
import { DirState, FileState, SyncState } from '../types';
import { AsyncMutex } from '../util/AsyncMutex';

const STATEDB_TMP_SUFFIX = '.tmp';
const SAVE_DEBOUNCE_MS = 2000;

export class StateDB {
  private state: SyncState;
  private readonly statePath: string;
  private readonly tmpPath: string;
  // Serializes the persist critical section: the non-atomic exists -> remove -> rename sequence must not interleave across callers.
  private readonly saveMutex = new AsyncMutex();
  // remoteFileId -> path reverse index (O(1) rename detection); kept in sync by setFile/deleteFile, rebuilt on load.
  private fileIdIndex = new Map<string, string>();
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
      let readPath = this.statePath;
      let recoveredFromTmp = false;
      if (!(await this.adapter.exists(readPath))) {
        // A crash between remove(statePath) and rename(tmpPath, statePath) leaves only tmp; without this
        // check load() would read it as a first run and discard the persisted state.
        if (!(await this.adapter.exists(this.tmpPath))) return;
        readPath = this.tmpPath;
        recoveredFromTmp = true;
      }
      const raw = await this.adapter.read(readPath);
      const parsed = JSON.parse(raw) as SyncState;
      this.state = parsed;
      if (!this.state.directories) this.state.directories = {}; // pre-DP v1 state file
      // Absent remoteRootEtag => the next sync does a real full scan (docs/spec.md §8a.5); skip count defaults to 0.
      if (this.state.fullScanSkipCount == null) this.state.fullScanSkipCount = 0;
      if (recoveredFromTmp) {
        // Adopt the recovered tmp; best-effort, the next save() recreates statePath from memory.
        await this.adapter.rename(this.tmpPath, this.statePath).catch(() => undefined);
      }
    } catch {
      // Corrupted DB — start fresh (recovery handled externally)
      console.warn('[StateDB] Failed to parse state DB; starting with empty state');
    }
    // A v1 state file lacks the optional signature fields; the fast-path hashes once and populates them, so no migration is needed.
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.fileIdIndex.clear();
    for (const [path, fs] of Object.entries(this.state.files)) {
      if (fs.remoteFileId) this.fileIdIndex.set(fs.remoteFileId, path);
    }
  }

  // Concurrent callers are serialized: exists -> remove -> rename is not atomic, so interleaved saves would race into ENOENT.
  save(): Promise<void> {
    return this.saveMutex.run(() => this.doSave());
  }

  // Coalesces watch-mode saves into one write. Crash window: at most SAVE_DEBOUNCE_MS of un-persisted watch ops,
  // re-checked on the next sync; full syncs call save() directly after flush().
  requestSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  // Runs any pending debounced save now and awaits it; call before a full-sync save and on unload so no update is lost.
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
    // Compact serialization: smaller payload and less stringify CPU on mobile; the file is machine-only.
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

  // null => the next sync full-scans (docs/spec.md §8a.5).
  getRemoteRootEtag(): string | null {
    return this.state.remoteRootEtag ?? null;
  }

  // Set ONLY after a real full scan completes, never on a short-circuit.
  setRemoteRootEtag(etag: string | null): void {
    this.state.remoteRootEtag = etag;
  }

  getFullScanSkipCount(): number {
    return this.state.fullScanSkipCount ?? 0;
  }

  setFullScanSkipCount(n: number): void {
    this.state.fullScanSkipCount = n;
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

  countConflicted(): number {
    return Object.values(this.state.files).filter(f => f.isConflicted).length;
  }

  snapshot(): SyncState {
    return JSON.parse(JSON.stringify(this.state)) as SyncState;
  }

  // Keeps deviceId; cancels any pending debounced save first so it cannot resurrect the old state.
  async reset(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.state = { deviceId: this.state.deviceId, lastSyncTime: 0, syncToken: null, files: {} };
    this.fileIdIndex.clear();
    await this.save();
  }

  // Variant for when no StateDB instance exists (plugin unconfigured); same atomic tmp -> rename as doSave.
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
