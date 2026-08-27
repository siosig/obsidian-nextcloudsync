// Directory reconciliation, lifted out of SyncEngine (feature 074, Phase 7).
//
// Directories are first-class entities here (spec 021), not a side effect of file paths: an empty
// folder created on one device has to appear on the other, and one deleted has to disappear. That
// makes the same three-way comparison the file path uses — local / remote / tracked — applicable to
// folders, and this module is where it lives.
//
// The mass-delete breaker is the reason this is worth reading closely. A partial remote listing looks
// exactly like "the user deleted most of their folders", so beyond a threshold the destructive half
// of the plan is refused wholesale and recorded as a session error. The two resolve* methods below
// are how the user then settles those refused paths without waiting for another sync.
import { TFolder, normalizePath, Vault, App } from 'obsidian';
import { SyncSessionSummary, RemoteDirInfo } from '../../types';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { SyncJournal } from '../session/SyncJournal';
import { TransferService } from '../transfer/TransferService';
import {
  classifyDirectories, shouldTripMassDeleteBreaker, breakerDenominator,
} from './classify';
import { FileLogger } from '../../util/FileLogger';

export interface DirectoryDeps {
  app: App;
  stateDB: Pick<StateDB, 'getAllDirs' | 'setDir' | 'deleteDir' | 'requestSave'>;
  journal: SyncJournal;
  /** Used only for the lock taken around a remote collection delete. */
  transfer: TransferService;
  /** The system-exclusion rules, already bound to the caller's settings. */
  isSystemExcluded(path: string): boolean;
  /** The configured mass-delete threshold, read at call time. */
  massDeleteLimit(): number;
  /**
   * Whether the running sync has been asked to stop. Checked between directory operations so a
   * cancel takes effect promptly instead of after the whole plan.
   */
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
      // Root-ETag short-circuit (spec 023): remote unchanged since the last real scan, so the tracked
      // directory set IS the remote set — skip the getDirectories('') Depth:infinity PROPFIND.
      remoteDirInfos = cachedDirs;
    } else {
      try {
        remoteDirInfos = await client.getDirectories('');
      } catch (err) {
        void this.deps.logger?.log(`dir-sync: listing failed — skip this session: ${(err as Error).message}`);
        return; // self-heal next sync
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

    // Circuit breaker on the destructive set (a partial listing would make many dirs look deleted).
    if (shouldTripMassDeleteBreaker(plan, breakerDenominator(remoteDirs, localDirs, tracked), this.deps.massDeleteLimit())) {
      void this.deps.logger?.log(`dir-sync: SKIPPED ${deleteRemote.length + trashLocal.length} dir deletions — exceeds safety limit; likely a partial listing`);
      // Record as an error so the root-ETag short-circuit convergence gate (spec 023 §8a.5) invalidates
      // the stored etag and the next sync really re-scans instead of short-circuiting on stale State.
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

    // CREATE remote (parents before children).
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
    // CREATE local (parents before children).
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
    // DELETE remote (children before parents; probe + optional lock).
    for (const p of deleteRemote.sort(deepFirst)) {
      if (this.deps.isCancelled()) break;
      let token: string | null = null;
      try {
        token = await this.deps.transfer.acquireLock(client, p);
        if (!(await client.isRemoteDirEmpty(p))) {
          void this.deps.logger?.log(`dir-sync: remote dir not empty yet — keeping → ${p}`);
          continue; // children pending — self-heal next sync
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
    // TRASH local (children before parents).
    for (const p of trashLocal.sort(deepFirst)) {
      if (this.deps.isCancelled()) break;
      const folder = this.deps.app.vault.getAbstractFileByPath(p);
      try {
        if (folder instanceof TFolder) await this.deps.app.fileManager.trashFile(folder);
        this.deps.stateDB.deleteDir(p);
        this.deps.journal.recordHistory(p, 'deleted');
      } catch (err) {
        summary.errorCount++;
        summary.errors.push({ path: p, message: `dir delete (local) failed: ${(err as Error).message}` });
      }
    }
    for (const d of ensureTracked) this.deps.stateDB.setDir(d);
    for (const p of dropTracked) this.deps.stateDB.deleteDir(p);
  }

  /**
   * Feature 056: resolve one skipped mass-delete-breaker directory candidate immediately (not
   * deferred to the next sync). `category` is which side reconcileDirectories would have deleted from
   * (`deleteRemote`: local absent/remote present; `trashLocal`: local present/remote absent). `choice`
   * mirrors the file-conflict force-resolution meaning: "remote" always means "make local match
   * remote", "local" always means "make remote match local" — expressed here as directory create/
   * delete instead of file push/pull. Recreated directories are tracked with `remoteFileId: null`
   * (the same self-healing pattern already used by createSingleFolder/renameSingleFolder — the next
   * full sync's real PROPFIND fills in the real id once both sides exist again). Throws on failure
   * without touching StateDB (the caller, `resolveAllSkippedDirs`, isolates per-path failures).
   */
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
        if (folder instanceof TFolder) await this.deps.app.fileManager.trashFile(folder);
        this.deps.stateDB.deleteDir(path);
      } else {
        // Local is correct: undo the apparent remote deletion by recreating it on the remote.
        await client.createDirectory(path);
        this.deps.stateDB.setDir({ path, remoteFileId: null });
      }
    }
    this.deps.stateDB.requestSave();
  }

  /**
   * Feature 056: bulk-apply one choice to every path in the current `(dir mass-delete breaker)`
   * session error's `dirBreakerSkipped`, sequentially (mirrors applyBulkForceResolution's sequencing
   * and per-path failure isolation — a per-path rejection is tallied, not thrown). On completion,
   * mutates the caller's summary errors IN PLACE: removes the breaker entry once every path resolved,
   * or narrows its `dirBreakerSkipped` to only the still-failed paths otherwise — so the next
   * `getStatusReport()` (which returns the same `lastSummary` reference, not a clone) reflects the
   * outcome immediately, without waiting for a fresh full sync.
   *
   * The caller is responsible for refusing to run this while a full sync is in progress: a
   * concurrent reconcileDirectories reads and writes the same StateDB directory rows.
   */
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
