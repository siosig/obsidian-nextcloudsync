import { DataAdapter } from 'obsidian';
import { FileState, SyncState } from '../types';

const STATEDB_TMP_SUFFIX = '.tmp';

export class StateDB {
  private state: SyncState;
  private readonly statePath: string;
  private readonly tmpPath: string;
  /** Serializes save() calls: watch-mode single-file ops and full syncs save concurrently. */
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: DataAdapter,
    private readonly pluginDir: string,
    deviceId: string,
  ) {
    this.statePath = `${pluginDir}/state-${deviceId}.json`;
    this.tmpPath = this.statePath + STATEDB_TMP_SUFFIX;
    this.state = { deviceId, lastSyncTime: 0, syncToken: null, files: {} };
  }

  async load(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.statePath))) return;
      const raw = await this.adapter.read(this.statePath);
      const parsed = JSON.parse(raw) as SyncState;
      this.state = parsed;
    } catch {
      // Corrupted DB — start fresh (recovery handled externally)
      console.warn('[StateDB] Failed to parse state DB; starting with empty state');
    }
  }

  /**
   * Atomically persist state to disk (tmp → rename). Concurrent callers are serialized:
   * the exists → remove → rename sequence is not atomic, so two interleaved saves used to
   * race each other into ENOENT on the unlink step.
   */
  save(): Promise<void> {
    const run = this.saveChain.then(() => this.doSave());
    // Keep the chain usable after a failure so later saves still run.
    this.saveChain = run.catch(() => {});
    return run;
  }

  private async doSave(): Promise<void> {
    const json = JSON.stringify(this.state, null, 2);
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
    return Object.values(this.state.files).find(f => f.remoteFileId === remoteFileId);
  }

  setFile(fileState: FileState): void {
    this.state.files[fileState.path] = fileState;
  }

  deleteFile(path: string): void {
    delete this.state.files[path];
  }

  getAllFiles(): FileState[] {
    return Object.values(this.state.files);
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
}
