// Mirror from remote, lifted out of SyncEngine (feature 074, Phase 7).
//
// A one-way reset: make the vault look like the server, then leave the state DB in a shape where the
// next ordinary sync sees no difference at all. It is not a sync — nothing is merged and nothing is
// uploaded — which is exactly why it is separable from the reconcile loop.
//
// Planning and applying are deliberately two calls. The plan is shown to the user before anything is
// touched, and a plan that could not be built reliably comes back with `ok: false` and an empty
// action list: a failed remote listing must produce ZERO deletions, never a plan that reads "the
// server has nothing, so delete everything".
import { TFolder, Vault, App } from 'obsidian';
import { FileState, RemoteFileInfo } from '../../types';
import { buildMirrorPlan, MirrorPlan, MirrorResult, LocalFileEntry } from '../mirrorPlan';
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

/**
 * The engine's progress surface. A port rather than a field because the counters are shared with an
 * ordinary sync — the status bar must not show two different notions of "how far along" depending on
 * which one is running.
 */
export interface MirrorProgress {
  begin(total: number): void;
  /** Advance by one and return how many are done. */
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
  /** Config-folder paths the enabled config-sync categories include. */
  enumerateIncludedConfigPaths(): Promise<string[]>;
  isSystemExcluded(path: string): boolean;
  /** Connect (or reuse the connection). Mirror can run before any sync has, so this may connect. */
  connect(): Promise<IWebDAVClient>;
  logger?: Pick<FileLogger, 'log'>;
}

export class MirrorService {
  constructor(private readonly deps: MirrorDeps) {}

  async planRemoteMirror(onPhase?: (label: string) => void): Promise<MirrorPlan> {
    // Lazily build (and cache) the WebDAV client + features, exactly like a normal sync does — the
    // client is only created on first sync, so a mirror invoked before any sync must connect here.
    onPhase?.('Connecting to the server…');
    let client: IWebDAVClient;
    try {
      client = await this.deps.connect();
    } catch (err) {
      return buildMirrorPlan([], [], [], () => false, false, `Not connected to the server: ${(err as Error).message}`);
    }

    // 1. Authoritative remote listing (no short-circuit). Failure ⇒ abort gate (zero deletions).
    onPhase?.('Reading the remote file list…');
    let remoteFiles: RemoteFileInfo[];
    try {
      remoteFiles = await client.getFiles('');
    } catch (err) {
      return buildMirrorPlan([], [], [], () => false, false, `Failed to list the remote: ${(err as Error).message}`);
    }

    // 2. Local files.
    onPhase?.('Comparing with local files…');
    const localStats = new Map<string, { size: number; mtime: number }>();
    await this.deps.localScanner.collectLocalStats(localStats);
    for (const p of await this.deps.enumerateIncludedConfigPaths()) {
      const st = await this.deps.localAdapter.stat(p);
      if (st) localStats.set(p, { size: st.size, mtime: st.mtime });
    }

    // 2a. Populate missing server-side checksums for files present on BOTH sides — server-computed,
    //     no download (Nextcloud ChecksumUpdatePlugin), same as a normal sync. Without this, files put
    //     on the server by another tool (the common migration case) carry no checksum, so every one
    //     would be re-downloaded even when byte-identical. Best-effort: unsupported servers leave the
    //     checksum null and those files fall back to download (still correct, just not skipped).
    onPhase?.('Checking server checksums…');
    await this.deps.remoteListing.resolveRemoteChecksums(client, remoteFiles, localStats);

    onPhase?.('Checking local files…');
    // Only hash a local file when its remote counterpart now carries a checksum we can compare against
    // (otherwise it would be downloaded regardless, so hashing would be wasted I/O).
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

    // 3. Local folders (empty ones included) for local-only folder deletion.
    const vault = this.deps.app.vault as Vault & { getAllFolders?: (includeRoot?: boolean) => TFolder[] };
    const localDirs = (vault.getAllFolders?.() ?? []).map((f) => f.path).filter((p) => p && p !== '/');

    return buildMirrorPlan(remoteFiles, localFiles, localDirs, (p) => this.deps.isSystemExcluded(p), true);
  }

  /**
   * Apply a Pull-mirror plan produced by {@link planRemoteMirror}: download everything the remote has
   * (or that differs), delete local-only files/folders (via the user's Obsidian "Deleted files"
   * setting — recoverable), then reconcile StateDB to the remote so the next normal sync converges to
   * zero diff (FR-011 / SC-002). The caller must pass an `ok:true` plan and have aborted in-flight sync.
   */
  async applyRemoteMirror(
    client: IWebDAVClient, plan: MirrorPlan, onProgress?: (done: number, total: number) => void,
  ): Promise<MirrorResult> {
    const result: MirrorResult = { downloaded: 0, deleted: 0, skipped: plan.skipCount, errors: [] };
    if (!plan.ok) return result;

    const summary = this.deps.journal.newSummary();

    // Progress reporting: identical surface to a normal "Sync now" — the status bar on desktop and the
    // single result toast on mobile (NoticeStatusBar), driven via setStatus/setProgress/tickProgress
    // and closed with setSyncComplete. Total = every action item (downloads + file/folder deletions).
    const total = plan.downloads.length + plan.deleteFiles.length + plan.deleteDirs.length;
    this.deps.progress.begin(total);
    this.deps.statusBar.setStatus('syncing');
    if (total > 0) this.deps.statusBar.setProgress(0, total);
    onProgress?.(0, total);
    // Advance the status-bar progress AND the dialog progress (feature 049) together. Two statements
    // on purpose: folding the tick into the optional call would make it conditional on a callback
    // being supplied, because `onProgress?.(...)` does not evaluate its arguments when onProgress is
    // undefined — and the status bar would then never move for a caller that passes none.
    const tick = (): void => {
      const done = this.deps.progress.tick();
      onProgress?.(done, total);
    };

    // 1. Downloads (remote wins — forced overwrite, not a 3-way merge).
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

    // 2. Delete local-only files (processRemoteDeletion honors the trash setting + cleans StateDB).
    for (const path of plan.deleteFiles) {
      try {
        await this.deps.deletion.processRemoteDeletion(path, summary);
        result.deleted++;
      } catch (err) {
        result.errors.push({ path, message: (err as Error).message });
      }
      tick();
    }

    // 3. Delete local-only folders child→parent (trashFile handles TFolder), then drop dir tracking.
    for (const path of plan.deleteDirs) {
      try {
        await this.deps.deletion.processRemoteDeletion(path, summary);
        this.deps.stateDB.deleteDir(path);
        result.deleted++;
      } catch (err) {
        result.errors.push({ path, message: (err as Error).message });
      }
      tick();
    }

    // 4. Reconcile StateDB to the remote so the next sync sees no diff (self-healing, FR-011).
    const eligibleRemote = plan.remoteFiles.filter((r) => !this.deps.isSystemExcluded(r.path));
    const downloadSet = new Set(plan.downloads.map((d) => d.path));
    // 4a. Skipped files (content already matched): downloadFile did NOT run for them, so ensure they
    //     are tracked as unchanged (localHash === remoteId) — otherwise an untracked-but-present file
    //     would be misread as a conflict next sync and break convergence.
    for (const remote of eligibleRemote) {
      if (downloadSet.has(remote.path)) continue; // already tracked by downloadFile
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
    // 4b. Drop any tracked file the remote no longer has (deleteFiles already dropped their entries;
    //     this also clears entries whose local file was absent locally but still tracked).
    const remoteSet = new Set(eligibleRemote.map((r) => r.path));
    for (const fs of this.deps.stateDB.getAllFiles()) {
      if (!this.deps.isSystemExcluded(fs.path) && !remoteSet.has(fs.path)) {
        this.deps.stateDB.deleteFile(fs.path);
        this.deps.mergeBase.drop(fs.path);
      }
    }
    // 4c. Force a real full scan next sync (never short-circuit) so convergence is genuinely verified.
    this.deps.stateDB.setRemoteRootEtag(null);
    this.deps.stateDB.setSyncToken('');

    // Close the progress surface with a result — exactly like a normal sync. On mobile this replaces
    // the "🔄 Syncing…" toast with the outcome (and auto-dismisses); on desktop it updates the bar.
    // Deletions are reflected in summary.downloadedCount (processRemoteDeletion increments it), matching
    // how a normal sync reports remote-deletions-applied-locally.
    summary.errorCount = result.errors.length;
    this.deps.statusBar.setSyncComplete(0, summary.downloadedCount, 0, result.errors.length);

    void this.deps.logger?.log(
      `mirror: applied — downloaded=${result.downloaded}, deleted=${result.deleted}, skipped=${result.skipped}, errors=${result.errors.length}`,
    );
    return result;
  }
}
