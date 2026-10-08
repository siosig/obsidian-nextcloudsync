// Three-way comparison (local / remote / tracked) applied to folders, so an empty folder created or deleted on
// one device propagates to the others (docs/spec.md §8a, docs/plan.md §16). A partial remote listing looks like
// "the user deleted most folders", so beyond the mass-delete threshold the destructive half of the plan is
// refused wholesale and recorded as a session error; the resolve* methods settle those paths on demand.
import { TFolder, normalizePath, Vault, App } from 'obsidian';
import { SyncSessionSummary, RemoteDirInfo } from '../../types';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { TransferService } from '../transfer/TransferService';
import {
  classifyDirectories, shouldTripMassDeleteBreaker, breakerDenominator,
} from './classify';
import { collectSubtreePaths, dropSubtreeTracking } from '../deletion/subtreeTracking';
import { FileLogger } from '../../util/FileLogger';

export interface DirectoryDeps {
  app: App;
  stateDB: Pick<StateDB,
    'getAllDirs' | 'setDir' | 'deleteDir' | 'requestSave' | 'getAllFiles' | 'deleteFile'>;
  journal: SyncJournal;
  // Used only for the lock taken around a remote collection delete.
  transfer: TransferService;
  // Dropped alongside the file state when a trashed folder's subtree stops being tracked.
  mergeBase: Pick<MergeBaseRecorder, 'drop'>;
  dropCleanSnapshot(path: string): void;
  // Registers a path so the vault event this plugin causes is not fed back to the watcher. Required: an
  // unwired no-op here turns a plugin trash back into a server DELETE.
  markOwnEvent(path: string): void;
  isSystemExcluded(path: string): boolean;
  massDeleteLimit(): number;
  // Checked between directory operations so a cancel takes effect promptly.
  isCancelled(): boolean;
  logger?: Pick<FileLogger, 'log'>;
}

export class DirectoryReconciler {
  constructor(private readonly deps: DirectoryDeps) {}

  async reconcileDirectories(
    client: IWebDAVClient, summary: SyncSessionSummary, cachedDirs?: RemoteDirInfo[],
  ): Promise<void> {
    let remoteDirInfos: RemoteDirInfo[];
    if (cachedDirs) {
      // Root-ETag short-circuit: the remote is unchanged since the last real scan, so the tracked set IS the
      // remote set (docs/spec.md §8a.5); skip the Depth:infinity PROPFIND.
      remoteDirInfos = cachedDirs;
    } else {
      try {
        remoteDirInfos = await client.getDirectories('');
      } catch (err) {
        void this.deps.logger?.log(`dir-sync: listing failed — skip this session: ${(err as Error).message}`);
        return; // self-heals next sync
      }
    }

    const norm = (p: string): string => p.replace(/\/+$/, '');
    const remoteDirs = new Map(remoteDirInfos.map(d => [norm(d.path), d]));
    const vault = this.deps.app.vault as Vault & { getAllFolders?: (includeRoot?: boolean) => TFolder[] };
    const localDirs = new Set(
      (vault.getAllFolders?.() ?? []).map(f => f.path).filter(p => p && p !== '/'),
    );
    const tracked = new Map(this.deps.stateDB.getAllDirs().map(d => [d.path, d]));

    const plan = classifyDirectories(remoteDirs, localDirs, tracked, (p) => this.deps.isSystemExcluded(p));
    const { mkcolRemote, mkdirLocal, deleteRemote, trashLocal, ensureTracked, dropTracked } = plan;

    // Circuit breaker: a partial listing would make many dirs look deleted.
    if (shouldTripMassDeleteBreaker(plan, breakerDenominator(remoteDirs, localDirs, tracked), this.deps.massDeleteLimit())) {
      void this.deps.logger?.log(`dir-sync: SKIPPED ${deleteRemote.length + trashLocal.length} dir deletions — exceeds safety limit; likely a partial listing`);
      // Recorded as an error so the root-ETag convergence gate invalidates the stored etag and the next sync
      // re-scans instead of short-circuiting on stale state (docs/spec.md §8a.5).
      const skippedDeleteRemote = [...deleteRemote];
      const skippedTrashLocal = [...trashLocal];
      this.deps.journal.recordError(
        summary, '(dir mass-delete breaker)',
        new Error(`Skipped ${deleteRemote.length + trashLocal.length} dir deletions — exceeds safety limit`),
        undefined,
        { deleteRemote: skippedDeleteRemote, trashLocal: skippedTrashLocal },
      );
      deleteRemote.length = 0;
      trashLocal.length = 0;
    }

    const shallowFirst = (a: string, b: string): number => a.split('/').length - b.split('/').length;
    const deepFirst = (a: string, b: string): number => b.split('/').length - a.split('/').length;

    // Parents before children.
    for (const p of mkcolRemote.sort(shallowFirst)) {
      if (this.deps.isCancelled()) break;
      try {
        await client.createDirectory(p);
        this.deps.stateDB.setDir({ path: p, remoteFileId: remoteDirs.get(p)?.fileId ?? null });
        this.deps.journal.recordHistory(p, 'uploaded');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir create (remote) failed: ${(err as Error).message}` });
      }
    }
    // Parents before children.
    for (const p of mkdirLocal.sort(shallowFirst)) {
      if (this.deps.isCancelled()) break;
      try {
        await this.deps.app.vault.adapter.mkdir(normalizePath(p));
        this.deps.stateDB.setDir({ path: p, remoteFileId: remoteDirs.get(p)?.fileId ?? null });
        this.deps.journal.recordHistory(p, 'downloaded');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir create (local) failed: ${(err as Error).message}` });
      }
    }
    // Children before parents; probe emptiness first, under an optional lock.
    for (const p of deleteRemote.sort(deepFirst)) {
      if (this.deps.isCancelled()) break;
      let token: string | null = null;
      try {
        token = await this.deps.transfer.acquireLock(client, p);
        if (!(await client.isRemoteDirEmpty(p))) {
          void this.deps.logger?.log(`dir-sync: remote dir not empty yet — keeping → ${p}`);
          continue; // children pending; self-heals next sync
        }
        await client.deleteCollection(p);
        this.deps.stateDB.deleteDir(p);
        summary.deletedCount++;
        this.deps.journal.recordHistory(p, 'deleted');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir delete (remote) failed: ${(err as Error).message}` });
      } finally {
        await this.deps.transfer.releaseLock(client, p, token);
      }
    }
    // Children before parents.
    for (const p of trashLocal.sort(deepFirst)) {
      if (this.deps.isCancelled()) break;
      // A folder absent from the listing is a reason to look, not to delete (issue #46): one missing folder
      // is below the mass-delete breaker. remoteExists treats everything but a definitive 404 as present, and
      // a rejecting client likewise: no proof, no deletion. The folder stays tracked for the next listing.
      let confirmedGone = false;
      try { confirmedGone = !(await client.remoteExists(p)); } catch { confirmedGone = false; }
      if (!confirmedGone) {
        void this.deps.logger?.log(`dir-sync: listing omitted ${p} but the server still has it — keeping it (not trashed)`);
        continue;
      }
      const folder = this.deps.app.vault.getAbstractFileByPath(p);
      try {
        if (folder instanceof TFolder) await this.trashFolder(folder);
        // Our own trash is not a user deletion: leftover child rows would be read next sync as local
        // deletions and pushed to the server.
        this.forgetSubtree(p);
        this.deps.journal.recordHistory(p, 'deleted');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir delete (local) failed: ${(err as Error).message}` });
      }
    }
    for (const d of ensureTracked) this.deps.stateDB.setDir(d);
    for (const p of dropTracked) this.deps.stateDB.deleteDir(p);
  }

  // Trashing fires a vault `delete` event for the folder and every file under it, which watch mode would push
  // as user deletions. Register the paths as our own FIRST: the events can land at any point after the trash.
  private async trashFolder(folder: TFolder): Promise<void> {
    const stale = collectSubtreePaths(this.deps.stateDB, folder.path);
    // The set keeps the folder from registering twice when it is also in `stale.dirs`.
    for (const path of new Set([folder.path, ...stale.files, ...stale.dirs])) {
      this.deps.markOwnEvent(path);
    }
    await this.deps.app.fileManager.trashFile(folder);
  }

  // Only ever called after a successful trash.
  private forgetSubtree(path: string): void {
    const dropped = dropSubtreeTracking(this.deps, path);
    if (dropped.files + dropped.dirs > 0) {
      void this.deps.logger?.log(
        `dir-sync: plugin trash — dropped tracking for ${dropped.files} files / ${dropped.dirs} dirs under ${path} (not a local deletion)`,
      );
    }
  }

  // Resolves one breaker-skipped directory immediately. `category` is the side reconcileDirectories would have
  // deleted from (`deleteRemote`: local absent/remote present; `trashLocal`: the reverse). `choice` "remote" makes
  // local match remote, "local" the reverse. Recreated directories get `remoteFileId: null`; the next full sync
  // fills in the real id. Throws without touching StateDB; resolveAllSkippedDirs isolates per-path failures.
  async resolveSkippedDir(
    client: IWebDAVClient,
    path: string,
    category: 'deleteRemote' | 'trashLocal',
    choice: 'remote' | 'local',
  ): Promise<void> {
    if (category === 'deleteRemote') {
      if (choice === 'remote') {
        // Remote is correct: undo the apparent local deletion by recreating the folder locally.
        await this.deps.app.vault.adapter.mkdir(normalizePath(path));
        this.deps.stateDB.setDir({ path, remoteFileId: null });
      } else {
        // Local absence is correct: let the deletion proceed on the remote.
        await client.deleteCollection(path);
        this.deps.stateDB.deleteDir(path);
      }
    } else {
      if (choice === 'remote') {
        // Remote absence is correct: let the deletion proceed locally.
        const folder = this.deps.app.vault.getAbstractFileByPath(path);
        if (folder instanceof TFolder) await this.trashFolder(folder);
        this.forgetSubtree(path);

      } else {
        // Local is correct: undo the apparent remote deletion by recreating it on the remote.
        await client.createDirectory(path);
        this.deps.stateDB.setDir({ path, remoteFileId: null });
      }
    }
    this.deps.stateDB.requestSave();
  }

  // Applies one choice to every path in the `(dir mass-delete breaker)` error's `dirBreakerSkipped`, tallying
  // per-path failures instead of throwing. Mutates the caller's summary errors IN PLACE (removes the entry, or
  // narrows it to the failed paths) because getStatusReport() returns the same `lastSummary` reference.
  // The caller must refuse to run this during a full sync: reconcileDirectories uses the same StateDB rows.
  async resolveAllSkippedDirs(
    client: IWebDAVClient,
    lastSummary: SyncSessionSummary | null,
    choice: 'remote' | 'local',
  ): Promise<{ resolved: number; failed: number }> {
    const errors = lastSummary?.errors;
    const entry = errors?.find((e) => e.path === '(dir mass-delete breaker)' && e.dirBreakerSkipped);
    if (!entry?.dirBreakerSkipped) return { resolved: 0, failed: 0 };

    const candidates: { path: string; category: 'deleteRemote' | 'trashLocal' }[] = [
      ...entry.dirBreakerSkipped.deleteRemote.map((path) => ({ path, category: 'deleteRemote' as const })),
      ...entry.dirBreakerSkipped.trashLocal.map((path) => ({ path, category: 'trashLocal' as const })),
    ];

    let resolved = 0;
    const failedDeleteRemote: string[] = [];
    const failedTrashLocal: string[] = [];
    for (const { path, category } of candidates) {
      try {
        await this.resolveSkippedDir(client, path, category, choice);
        resolved++;
      } catch {
        (category === 'deleteRemote' ? failedDeleteRemote : failedTrashLocal).push(path);
      }
    }

    const failed = failedDeleteRemote.length + failedTrashLocal.length;
    if (failed === 0) {
      const idx = errors!.indexOf(entry);
      if (idx >= 0) errors!.splice(idx, 1);
    } else {
      entry.dirBreakerSkipped = { deleteRemote: failedDeleteRemote, trashLocal: failedTrashLocal };
    }
    return { resolved, failed };
  }
}
