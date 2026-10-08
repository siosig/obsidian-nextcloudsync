// One-way reset: make the vault look like the server, then leave the state DB so the next ordinary sync
// sees no difference. Planning and applying are separate calls; a plan that could not be built reliably
// returns `ok: false` with no actions, so a failed remote listing yields ZERO deletions.
import { TFolder, Vault, App } from 'obsidian';
import { FileState, RemoteFileInfo } from '../../types';
import { buildMirrorPlan, MirrorPlan, MirrorResult, LocalFileEntry } from '../mirrorPlan';
import { planStateConvergence } from './convergence';
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
    | 'setRemoteRootEtag' | 'setSyncToken'>;
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
  // Mirror can run before any sync has, so this may need to connect.
  connect(): Promise<IWebDAVClient>;
  logger?: Pick<FileLogger, 'log'>;
}

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
    try {
      remoteFiles = await client.getFiles('');
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
    for (const [path] of localStats) {
      let hash = '';
      const cs = remoteChecksum.get(path);
      if (cs != null && !this.deps.isSystemExcluded(path)) {
        try {
          hash = await sha256(await this.deps.localAdapter.readBinary(path));
        } catch {
          hash = '';
        }
      }
      localFiles.push({ path, hash });
    }

    // Empty folders included, for local-only folder deletion.
    const vault = this.deps.app.vault as Vault & { getAllFolders?: (includeRoot?: boolean) => TFolder[] };
    const localDirs = (vault.getAllFolders?.() ?? []).map((f) => f.path).filter((p) => p && p !== '/');

    return buildMirrorPlan(remoteFiles, localFiles, localDirs, (p) => this.deps.isSystemExcluded(p), true);
  }

  // The caller must pass an `ok:true` plan and have aborted any in-flight sync. Local-only files go through
  // the user's "Deleted files" setting, so they are recoverable.
  async applyRemoteMirror(
    client: IWebDAVClient, plan: MirrorPlan, onProgress?: (done: number, total: number) => void,
  ): Promise<MirrorResult> {
    const result: MirrorResult = { downloaded: 0, deleted: 0, skipped: plan.skipCount, errors: [] };
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

    const { toTrack, toDrop } = planStateConvergence(
      plan.remoteFiles,
      new Set(plan.downloads.map((d) => d.path)),
      this.deps.stateDB.getAllFiles().map((f) => f.path),
      (p) => this.deps.isSystemExcluded(p),
    );
    // Skipped files (content already matched) never ran downloadFile; track them as unchanged
    // (localHash === remoteId), else the next sync reads them as a conflict.
    for (const remote of toTrack) {
      const remoteId = remote.checksum ?? remote.etag ?? String(remote.size);
      const idType: FileState['idType'] = remote.checksum ? 'sha256' : (remote.etag ? 'etag' : 'size');
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
    // Force a real full scan next sync so convergence is verified without a short-circuit.
    this.deps.stateDB.setRemoteRootEtag(null);
    this.deps.stateDB.setSyncToken('');

    // Deletions are counted in summary.downloadedCount (processRemoteDeletion increments it), as in a normal sync.
    summary.errorCount = result.errors.length;
    this.deps.statusBar.setSyncComplete(0, summary.downloadedCount, 0, result.errors.length);

    void this.deps.logger?.log(
      `mirror: applied — downloaded=${result.downloaded}, deleted=${result.deleted}, skipped=${result.skipped}, errors=${result.errors.length}`,
    );
    return result;
  }
}
