// One-way reset: make the vault look like the server, then leave the state DB so the next ordinary sync
// sees no difference. Planning and applying are separate calls; a plan that could not be built reliably
// returns `ok: false` with no actions, so a failed remote listing yields ZERO deletions.
import { TFolder, Vault, App, normalizePath } from 'obsidian';
import { FileState, RemoteFileInfo, RemoteDirInfo } from '../../types';
import { buildMirrorPlan, MirrorPlan, MirrorResult, LocalFileEntry } from '../mirrorPlan';
import { planStateConvergence, planDirConvergence } from './convergence';
import { LocalAdapter } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { IStatusBar } from '../../ui/StatusBarItem';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { TransferService } from '../transfer/TransferService';
import { DeletionService } from '../deletion/DeletionService';
import { LocalScanner } from '../scan/LocalScanner';
import { RemoteListingSource } from '../scan/RemoteListingSource';
import { withLocalSignature } from '../../data/localSignature';
import { FileLogger } from '../../util/FileLogger';
import { sha256 } from '../../util/hash';

// A port because the counters are shared with an ordinary sync; the status bar must show one notion of progress.
export interface MirrorProgress {
  begin(total: number): void;
  tick(): number;
}

export interface MirrorDeps {
  app: App;
  localAdapter: Pick<LocalAdapter, 'stat' | 'readBinary'>;
  stateDB: Pick<StateDB,
    'getFile' | 'setFile' | 'getAllFiles' | 'deleteFile' | 'deleteDir'
    | 'getAllDirs' | 'setDir' | 'setRemoteRootEtag' | 'setSyncToken'>;
  statusBar: IStatusBar;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  transfer: TransferService;
  deletion: DeletionService;
  localScanner: Pick<LocalScanner, 'collectLocalStats'>;
  remoteListing: Pick<RemoteListingSource, 'resolveRemoteChecksums'>;
  progress: MirrorProgress;
  enumerateIncludedConfigPaths(): Promise<string[]>;
  isSystemExcluded(path: string): boolean;
  // Writes the state DB, the merge bases and the history to disk; rejects when a write fails.
  persist(): Promise<void>;
  // Mirror can run before any sync has, so this may need to connect.
  connect(): Promise<IWebDAVClient>;
  logger?: Pick<FileLogger, 'log'>;
}

// Path reported in MirrorResult.errors when the final state save fails (it belongs to no file).
export const STATE_SAVE_ERROR_PATH = '(state save)';

export class MirrorService {
  constructor(private readonly deps: MirrorDeps) {}

  async planRemoteMirror(onPhase?: (label: string) => void): Promise<MirrorPlan> {
    onPhase?.('Connecting to the server…');
    let client: IWebDAVClient;
    try {
      client = await this.deps.connect();
    } catch (err) {
      return buildMirrorPlan([], [], [], () => false, false, `Not connected to the server: ${(err as Error).message}`);
    }

    // Authoritative remote listing (no short-circuit); a failure aborts with zero deletions.
    onPhase?.('Reading the remote file list…');
    let remoteFiles: RemoteFileInfo[];
    let remoteDirs: RemoteDirInfo[];
    try {
      remoteFiles = await client.getFiles('');
      remoteDirs = await client.getDirectories('');
    } catch (err) {
      return buildMirrorPlan([], [], [], () => false, false, `Failed to list the remote: ${(err as Error).message}`);
    }

    onPhase?.('Comparing with local files…');
    const localStats = new Map<string, { size: number; mtime: number }>();
    await this.deps.localScanner.collectLocalStats(localStats);
    for (const p of await this.deps.enumerateIncludedConfigPaths()) {
      const st = await this.deps.localAdapter.stat(p);
      if (st) localStats.set(p, { size: st.size, mtime: st.mtime });
    }

    // Server-computed checksums for files on both sides (no download). Without them, files put on the server
    // by another tool carry none and are re-downloaded even when identical. Best-effort: unsupported servers
    // leave null and those files fall back to download.
    onPhase?.('Checking server checksums…');
    await this.deps.remoteListing.resolveRemoteChecksums(client, remoteFiles, localStats);

    onPhase?.('Checking local files…');
    // Hash only when the remote counterpart has a checksum to compare against; otherwise it is downloaded anyway.
    const remoteChecksum = new Map(remoteFiles.map((r) => [r.path, r.checksum] as const));
    const localFiles: LocalFileEntry[] = [];
    for (const [path, st] of localStats) {
      let hash = '';
      const cs = remoteChecksum.get(path);
      if (cs != null && !this.deps.isSystemExcluded(path)) {
        try {
          hash = await sha256(await this.deps.localAdapter.readBinary(path));
        } catch {
          hash = '';
        }
      }
      localFiles.push({ path, hash, size: st.size, mtime: st.mtime });
    }

    // Empty folders included, for local-only folder deletion.
    const localDirs = this.readLocalDirs();

    return buildMirrorPlan(remoteFiles, localFiles, localDirs, (p) => this.deps.isSystemExcluded(p), true, null, remoteDirs);
  }

  // The caller must pass an `ok:true` plan and have aborted any in-flight sync. Local-only files go through
  // the user's "Deleted files" setting, so they are recoverable.
  async applyRemoteMirror(
    client: IWebDAVClient, plan: MirrorPlan, onProgress?: (done: number, total: number) => void,
  ): Promise<MirrorResult> {
    const result: MirrorResult = { downloaded: 0, deleted: 0, skipped: plan.skipCount, createdDirs: 0, errors: [] };
    if (!plan.ok) return result;

    const summary = this.deps.journal.newSummary();

    // Total = every action item (downloads + file/folder deletions).
    const total = plan.downloads.length + plan.deleteFiles.length + plan.deleteDirs.length;
    this.deps.progress.begin(total);
    this.deps.statusBar.setStatus('syncing');
    if (total > 0) this.deps.statusBar.setProgress(0, total);
    onProgress?.(0, total);
    // Two statements on purpose: `onProgress?.(this.deps.progress.tick(), ...)` would skip the tick when no
    // callback is supplied, and the status bar would never move.
    const tick = (): void => {
      const done = this.deps.progress.tick();
      onProgress?.(done, total);
    };

    try {
      // Remote wins: forced overwrite, not a 3-way merge.
      for (const remote of plan.downloads) {
        const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
        const idType: FileState['idType'] = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');
        try {
          const before = summary.downloadedCount;
          await this.deps.transfer.downloadFile(client, remote, remoteId, idType, summary);
          if (summary.downloadedCount > before) result.downloaded++;
        } catch (err) {
          result.errors.push({ path: remote.path, message: (err as Error).message });
        }
        tick();
      }

      for (const path of plan.deleteFiles) {
        try {
          await this.deps.deletion.processRemoteDeletion(path, summary);
          result.deleted++;
        } catch (err) {
          result.errors.push({ path, message: (err as Error).message });
        }
        tick();
      }

      // Local-only folders, child to parent. Dir tracking is dropped inside processRemoteDeletion with the subtree's.
      for (const path of plan.deleteDirs) {
        try {
          await this.deps.deletion.processRemoteDeletion(path, summary);
          result.deleted++;
        } catch (err) {
          result.errors.push({ path, message: (err as Error).message });
        }
        tick();
      }

      // Remote folders missing locally; progress is not ticked because creation is not part of the total.
      for (const path of plan.createDirs) {
        try {
          await this.deps.app.vault.adapter.mkdir(normalizePath(path));
          result.createdDirs++;
        } catch (err) {
          result.errors.push({ path, message: (err as Error).message });
        }
      }

      const { toTrack, toDrop } = planStateConvergence(
        plan.remoteFiles,
        new Set(plan.downloads.map((d) => d.path)),
        this.deps.stateDB.getAllFiles().map((f) => f.path),
        (p) => this.deps.isSystemExcluded(p),
      );
      const plannedByPath = new Map(plan.skipped.map((s) => [s.path, s] as const));
      // Skipped files (content already matched) never ran downloadFile; track them as unchanged
      // (localHash === remoteId), else the next sync reads them as a conflict.
      for (const remote of toTrack) {
        const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
        const idType: FileState['idType'] = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');
        // A file that changed after the plan was built must not be marked converged: the next sync decides.
        const planned = plannedByPath.get(remote.path);
        const nowStat = await this.deps.localAdapter.stat(remote.path);
        if (!planned || !nowStat || nowStat.size !== planned.size || nowStat.mtime !== planned.mtime) {
          void this.deps.logger?.log(`mirror: ${remote.path} changed locally since the plan — left for the next sync`);
          continue;
        }
        const existing = this.deps.stateDB.getFile(remote.path);
        const localHash = remote.checksum ?? existing?.localHash ?? remoteId;
        this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
          path: remote.path, localHash, remoteId, idType,
          size: remote.size, mtime: remote.lastModified || (existing?.mtime ?? 0),
          remoteFileId: remote.fileId, isConflicted: false,
        }, remote.lastModified));
      }
      // Also clears entries whose local file was already absent but still tracked.
      for (const path of toDrop) {
        this.deps.stateDB.deleteFile(path);
        this.deps.mergeBase.drop(path);
      }
      const localDirsNow = new Set(this.readLocalDirs());
      const dirs = planDirConvergence(
        plan.remoteDirs,
        localDirsNow,
        this.deps.stateDB.getAllDirs().map((d) => d.path),
        (p) => this.deps.isSystemExcluded(p),
      );
      for (const d of dirs.toTrack) this.deps.stateDB.setDir({ path: d.path, remoteFileId: d.remoteFileId });
      for (const path of dirs.toDrop) this.deps.stateDB.deleteDir(path);
      // Force a real full scan next sync so convergence is verified without a short-circuit.
      this.deps.stateDB.setRemoteRootEtag(null);
      this.deps.stateDB.setSyncToken('');
    } finally {
      await this.persistSafely(result);
    }

    // Deletions are counted in summary.downloadedCount (processRemoteDeletion increments it), as in a normal sync.
    summary.errorCount = result.errors.length;
    this.deps.statusBar.setSyncComplete(0, summary.downloadedCount, 0, result.errors.length);

    void this.deps.logger?.log(
      `mirror: applied — downloaded=${result.downloaded}, deleted=${result.deleted}, skipped=${result.skipped}, createdDirs=${result.createdDirs}, errors=${result.errors.length}`,
    );
    return result;
  }

  // Empty folders included; the vault root is not a folder to track.
  private readLocalDirs(): string[] {
    const vault = this.deps.app.vault as Vault & { getAllFolders?: (includeRoot?: boolean) => TFolder[] };
    return (vault.getAllFolders?.() ?? []).map((f) => f.path).filter((p) => p && p !== '/');
  }

  // Never throws: a failed save is reported as one more error so the result is not shown as a success.
  private async persistSafely(result: MirrorResult): Promise<void> {
    try {
      await this.deps.persist();
    } catch (err) {
      result.errors.push({ path: STATE_SAVE_ERROR_PATH, message: `Could not save the sync state: ${(err as Error).message}` });
      void this.deps.logger?.log(`mirror: state save FAILED — ${(err as Error).message}`, 'error');
    }
  }
}
