// Carries out ConflictResolver's decision. No outcome may report success it did not achieve: a failed
// push must leave the file conflicted with the previous baseline intact (docs/spec.md §6).
// Called by the sync loop and never calls back into it.
import {
  FileState, RemoteFileInfo, SyncSessionSummary, SyncHistoryDetail, ConflictResolution,
  FileLockedError,
} from '../../types';
import { LocalAdapter, type LocalStat } from '../../data/LocalAdapter';
import { StateDB } from '../../data/StateDB';
import { MergeBaseStore } from '../../data/MergeBaseStore';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { IUploadStrategy } from '../upload/IUploadStrategy';
import { ConflictResolver, hasOrphanMarker, MergeConfig } from '../ConflictResolver';
import { SyncJournal } from '../session/SyncJournal';
import { MergeBaseRecorder } from '../session/MergeBaseRecorder';
import { TransferService } from '../transfer/TransferService';
import { ResolutionService } from '../resolution/ResolutionService';
import { withLocalSignature } from '../../data/localSignature';
import { isMarkdown } from '../../util/mergeableExtensions';
import { isAnomalousRemoteContent } from '../../util/limits';
import { FileLogger } from '../../util/FileLogger';
import { sha256 } from '../../util/hash';
import { uploadCreationTimeMs, writeCreationTimeMs } from '../../util/creationTime';
import { bytesEqual, checksumProvesIdentical, convergedState } from '../identity/contentIdentity';
import type { LocalWritePort, PluginConflictRule } from '../plugins/PluginSyncCoordinator';
import type { App } from 'obsidian';
import type { CreationTimePort } from '../ctime/CreationTimeAligner';

export interface Connection {
  client: IWebDAVClient;
  uploadStrategy: IUploadStrategy;
}

export interface ConflictDeps {
  // Aligns the creation time of files whose body this sync left unchanged (docs/spec.md §9.7). Optional so tests
  // can omit it; the engine always passes one.
  creationTime?: CreationTimePort;
  app: App;
  localAdapter: LocalAdapter;
  stateDB: Pick<StateDB, 'getFile' | 'setFile' | 'setRemoteRootEtag'>;
  baseStore?: Pick<MergeBaseStore, 'get'>;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  transfer: TransferService;
  resolution: Pick<ResolutionService, 'captureCleanSides'>;
  localWrite: LocalWritePort;
  // The conflict rule for a plugin file, or null for any other path.
  pluginConflictRule(path: string): PluginConflictRule | null;
  // Read at call time so a settings change takes effect.
  resolverConfig(): MergeConfig;
  maxFileSizeMB(): number;
  queueRetry(path: string): void;
  onConflictEncountered(): void;
  logger?: Pick<FileLogger, 'log'>;
}

// Where a whole-file pick keeps the losing local body: next to the file, named after it, in local time.
export function conflictCopyPath(path: string, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const dot = path.lastIndexOf('.');
  const hasExt = dot > path.lastIndexOf('/') + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : '';
  return `${stem} (conflict ${stamp})${ext}`;
}

export class ConflictApplier {
  constructor(private readonly deps: ConflictDeps) {}

  async handleConflict(
    conn: Connection,
    path: string, base: FileState | undefined, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    // An oversized remote cannot be fetched without risking OOM: keep local untouched and flag the file
    // conflicted. No retry, since it would fail identically until the cap is raised.
    if (this.deps.transfer.isRemoteOverSizeLimit(remote)) {
      this.deps.onConflictEncountered();
      this.deps.transfer.warnDownloadSkipped(path, remote.size);
      if (base) this.deps.stateDB.setFile({ ...base, isConflicted: true });
      void this.deps.logger?.log(`conflict: remote over size limit (${remote.size}B > ${this.deps.maxFileSizeMB()}MB), skipped → ${path}`);
      return;
    }

    // Must precede any merge write: feeds the size/mtime strategies and the clean-side capture.
    const localStatBefore = await this.deps.localAdapter.stat(path);
    const identity = await this.convergeIfIdentical(conn, path, remote, localStatBefore);
    if (identity.converged) return;
    this.deps.onConflictEncountered();
    const localMtimeBefore = localStatBefore?.mtime ?? 0;
    const localSizeBefore = localStatBefore?.size ?? 0;

    // Config-folder JSON has no special branch: its extension is not in autoMergeFileTypes, so it falls to
    // `otherFileStrategy` (default latest-mtime), which never writes markers (docs/spec.md §6.1).
    const resolver = new ConflictResolver(this.deps.app, this.deps.localAdapter, this.deps.resolverConfig());
    const ctx = {
      localSize: localSizeBefore,
      remoteSize: remote.size,
      localMtime: localMtimeBefore,
      remoteMtime: remote.lastModified || 0,
    };

    // Plugin files never enter text merge: the coordinator's rule decides without reading the local body.
    const rule = this.deps.pluginConflictRule(path);
    if (rule !== null) {
      const ruled = this.decideByPluginRule(rule, path, ctx);
      await this.applyDecision(conn, path, base, remote, remoteId, idType, summary, ruled, identity.remoteData);
      return;
    }

    // `merge` and every markdown file need both sides' text; the other strategies decide from size/mtime,
    // so their remote download is deferred until required.
    let remoteData: ArrayBuffer | undefined = identity.remoteData;
    let decision: ConflictResolution;
    if (resolver.strategyFor(path) === 'merge' || isMarkdown(path)) {
      const localContent = await this.deps.localAdapter.read(path);
      remoteData = remoteData ?? await conn.client.downloadFile(remote.path);
      const remoteContent = new TextDecoder().decode(remoteData);
      // The stored last-synced body is the 3-way base, so shared blocks are not duplicated. Empty when none
      // is known yet; the expansion guard prevents a corrupt write and the next convergence seeds it.
      const mergeBaseContent = this.deps.baseStore?.get(path) ?? '';
      // A lone half-marker is merged normally and self-heals; log the re-entrancy-guard bypass.
      if (hasOrphanMarker(localContent) || hasOrphanMarker(remoteContent)) {
        void this.deps.logger?.log(`conflict: orphan marker detected, bypassing re-entrancy guard (self-heal) → ${path}`);
      }
      decision = resolver.decide(path, mergeBaseContent, localContent, remoteContent, ctx);
      // Only a marker write overwrites both clean sides, so capture them before resolveByWrite runs; force
      // resolution later restores a clean version from them (docs/spec.md §6.4).
      if (decision.action === 'write' && !decision.clean) {
        this.deps.resolution.captureCleanSides(path, localContent, remoteContent, localMtimeBefore, localSizeBefore, remote);
      }
    } else {
      decision = resolver.decide(path, '', '', '', ctx);
    }

    // Prefer-remote overwrites a local edit that never reached the server, so nothing else could restore it.
    // Prefer-local needs no copy: Nextcloud keeps the overwritten remote body in its version history.
    if (decision.action === 'prefer-remote') {
      try {
        await this.keepLocalCopy(path);
      } catch (err) {
        this.deps.journal.recordError(summary, path, err);
        if (base) this.deps.stateDB.setFile({ ...base, isConflicted: true });
        void this.deps.logger?.log(`conflict: conflict copy failed (${(err as Error).message}), local left untouched: ${path}`);
        return;
      }
    }

    await this.applyDecision(conn, path, base, remote, remoteId, idType, summary, decision, remoteData);
  }

  private async keepLocalCopy(path: string): Promise<void> {
    const copy = conflictCopyPath(path, new Date());
    await this.deps.localAdapter.atomicWriteBinary(copy, await this.deps.localAdapter.readBinary(path));
    void this.deps.logger?.log(`conflict: local body kept as ${copy}`);
  }

  private decideByPluginRule(
    rule: PluginConflictRule, path: string,
    ctx: { localSize: number; remoteSize: number; localMtime: number; remoteMtime: number },
  ): ConflictResolution {
    if (rule.kind === 'force') return { action: rule.action };
    // No auto-merge types, so the strategy alone decides and no body is read.
    const resolver = new ConflictResolver(this.deps.app, this.deps.localAdapter, {
      ...this.deps.resolverConfig(), autoMergeFileTypes: [], otherFileStrategy: rule.strategy,
    });
    return resolver.decide(path, '', '', '', ctx);
  }

  private async applyDecision(
    conn: Connection,
    path: string, base: FileState | undefined, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
    decision: ConflictResolution, fetched: ArrayBuffer | undefined,
  ): Promise<void> {
    let remoteData = fetched;
    switch (decision.action) {
      case 'safe-hold':
        // Markers would corrupt a non-text file: leave both sides untouched and flag it conflicted, with
        // no retry and the StateDB base unchanged so the divergence persists for manual resolution.
        if (base) this.deps.stateDB.setFile({ ...base, isConflicted: true });
        summary.conflictedCount++;
        this.deps.journal.recordHistory(path, 'conflicted');
        void this.deps.logger?.log(`conflict: non-text under merge → safe-hold, both sides untouched → ${path}`);
        return;

      case 'no-op':
        // A tie leaves both sides and the StateDB untouched and unflagged; the next sync re-evaluates.
        void this.deps.logger?.log(`conflict: deterministic tie → no-op, both sides untouched → ${path}`);
        // The tie leaves the sides divergent but changes no ETag or counter, so finalizeScan cannot see it.
        // An armed root-ETag short-circuit would misread it as a local-only change and upload over the other
        // device's edit; clearing the ETag forces a real scan (docs/spec.md §8a.5).
        this.deps.stateDB.setRemoteRootEtag(null);
        return;

      case 'prefer-local':
        await this.resolveByPreferLocal(conn, path, remote, summary);
        return;

      case 'prefer-remote':
        if (!remoteData) remoteData = await conn.client.downloadFile(remote.path);
        await this.resolveByPreferRemote(path, remote, remoteData, remoteId, idType, summary, conn.client);
        return;

      case 'write':
        await this.resolveByWrite(conn, path, decision.content, decision.clean, remote, remoteId, idType, summary);
        return;
    }
  }

  // Proof of identity is the server checksum, or the fetched body when the server has none and the sizes match.
  private async convergeIfIdentical(
    conn: Connection, path: string, remote: RemoteFileInfo,
    localStat: LocalStat | null,
  ): Promise<{ converged: boolean; remoteData?: ArrayBuffer }> {
    if (!localStat) return { converged: false };
    const localData = await this.deps.localAdapter.readBinary(path);
    const localHash = await sha256(localData);
    let remoteData: ArrayBuffer | undefined;
    let identical = false;
    if (remote.checksum) {
      identical = checksumProvesIdentical(remote, localHash);
    } else if (localData.byteLength === remote.size) {
      remoteData = await conn.client.downloadFile(remote.path);
      identical = bytesEqual(localData, remoteData);
    }
    if (!identical) return { converged: false, remoteData };
    this.deps.stateDB.setFile(await withLocalSignature(
      this.deps.localAdapter, convergedState(remote, localHash, localStat), remote.lastModified,
    ));
    this.deps.mergeBase.recordBytes(path, localData);
    await this.deps.creationTime?.align(conn.client, remote, localStat);
    void this.deps.logger?.log(`conflict: content identical to the remote → state converged, no transfer → ${path}`);
    return { converged: true };
  }

  async resolveByWrite(
    conn: Connection,
    path: string, content: string, clean: boolean, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    // One merge time, read once: the local write, the X-OC-MTime of the upload and the stored state all use it.
    // (PROPPATCH of mtime is silently ignored on Nextcloud, so the upload header is what sets the remote time.)
    const mergeMtime = Date.now();
    const before = await this.deps.localAdapter.stat(path);
    await this.deps.localAdapter.atomicWrite(
      path, content, mergeMtime, writeCreationTimeMs(before?.ctime, remote.creationTime),
    );

    // Without this push the merge stays local-only and every later sync re-detects the same conflict.
    const mergedData = await this.deps.localAdapter.readBinary(path);
    const mergedHash = await sha256(mergedData);
    let uploaded = false;
    try {
      const lockToken = await this.deps.transfer.acquireLock(conn.client, path);
      try {
        const outcome = await conn.uploadStrategy.upload(conn.client, path, mergedData, mergeMtime, {
          ctime: uploadCreationTimeMs(before?.ctime, remote.creationTime),
        });
        if (outcome !== 'skipped') { summary.uploadedCount++; uploaded = true; this.deps.journal.recordHistory(path, 'uploaded'); }
      } finally {
        await this.deps.transfer.releaseLock(conn.client, path, lockToken);
      }
    } catch (err) {
      // Locked or transient failure: keep the conflict and retry next sync.
      this.deps.queueRetry(path);
      if (!(err instanceof FileLockedError)) {
        void this.deps.logger?.log(`conflict: merge upload failed (${(err as Error).message}); queued retry → ${path}`);
      }
    }

    const stat = await this.deps.localAdapter.stat(path);
    const prior = this.deps.stateDB.getFile(path);
    const nextState: FileState = {
      path,
      // A failed push keeps the old baseline so the next sync still sees a local change and re-pushes.
      localHash: uploaded ? mergedHash : (prior?.localHash ?? ''),
      remoteId: uploaded ? mergedHash : remoteId,
      idType: uploaded ? 'sha256' : idType,
      size: stat?.size ?? 0, mtime: mergeMtime,
      remoteFileId: remote.fileId,
      // Stays true after a failed upload even for a clean merge, or the next sync reads the state as converged.
      isConflicted: !clean || !uploaded,
    };
    // After a failed push localHash deliberately differs from the file; a signature would let the
    // local-unchanged fast path skip the re-hash that drives the retry.
    this.deps.stateDB.setFile(
      uploaded ? await withLocalSignature(this.deps.localAdapter, nextState, remote.lastModified) : nextState,
    );
    const mergeDetail: SyncHistoryDetail = {
      localHash: mergedHash,
      remoteId: uploaded ? mergedHash : remoteId,
      remoteIdType: uploaded ? 'sha256' : idType,
      localSize: stat?.size ?? 0,
      remoteSize: remote.size,
    };
    if (clean) {
      summary.mergedCount++;
      this.deps.journal.recordHistory(path, 'merged', undefined, mergeDetail);
      // Advance the merge base only once the merge reached the server; otherwise the sides have not converged.
      if (uploaded) this.deps.mergeBase.record(path, content);
    } else {
      summary.conflictedCount++;
      this.deps.journal.recordHistory(path, 'conflicted', undefined, mergeDetail);
    }
    void this.deps.logger?.log(`conflict: ${clean ? 'auto-merged clean' : 'wrote conflict markers'}, uploaded=${uploaded} → ${path}`);
  }

  async resolveByPreferLocal(
    conn: Connection, path: string, remote: RemoteFileInfo, summary: SyncSessionSummary,
  ): Promise<void> {
    const stat = await this.deps.localAdapter.stat(path);
    const mtime = stat?.mtime ?? Date.now();
    const localData = await this.deps.localAdapter.readBinary(path);
    const localHash = await sha256(localData);
    try {
      const lockToken = await this.deps.transfer.acquireLock(conn.client, path);
      try {
        const outcome = await conn.uploadStrategy.upload(conn.client, path, localData, mtime, {
          ctime: uploadCreationTimeMs(stat?.ctime, remote.creationTime),
        });
        if (outcome === 'skipped') {
          // Skipped (e.g. size limit): leave the conflict unresolved.
          this.deps.queueRetry(path);
          return;
        }
      } finally {
        await this.deps.transfer.releaseLock(conn.client, path, lockToken);
      }
    } catch (err) {
      // Never mark converged on failure.
      this.deps.journal.recordError(summary, path, err);
      this.deps.queueRetry(path);
      if (!(err instanceof FileLockedError)) {
        void this.deps.logger?.log(`conflict: prefer-local upload failed (${(err as Error).message}); queued retry → ${path}`);
      }
      return;
    }
    summary.uploadedCount++;
    this.deps.journal.recordHistory(path, 'local-wins', undefined, {
      localHash, remoteId: localHash, remoteIdType: 'sha256',
      localSize: stat?.size ?? localData.byteLength, remoteSize: remote.size,
    });
    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path, localHash, remoteId: localHash, idType: 'sha256',
      size: stat?.size ?? localData.byteLength, mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    }, remote.lastModified));
    this.deps.mergeBase.recordBytes(path, localData);
    void this.deps.logger?.log(`conflict: resolved by prefer-local (remote overwritten) → ${path}`);
  }

  async resolveByPreferRemote(
    path: string, remote: RemoteFileInfo, remoteData: ArrayBuffer,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
    client?: IWebDAVClient,
  ): Promise<void> {
    // Never overwrite local with a body whose length disagrees with the advertised size (0-byte or truncated).
    if (isAnomalousRemoteContent(remote.size, remoteData.byteLength)) {
      this.deps.journal.recordError(summary, path, new Error(`Refused prefer-remote overwrite: advertised ${remote.size} bytes but body is ${remoteData.byteLength} (server anomaly)`));
      this.deps.queueRetry(path);
      void this.deps.logger?.log(`conflict: prefer-remote REFUSED anomalous remote (size ${remote.size}≠${remoteData.byteLength}) → kept local, queued retry → ${path}`);
      return;
    }
    try {
      const before = await this.deps.localAdapter.stat(path);
      await this.deps.localAdapter.atomicWriteBinary(
        path, remoteData, this.deps.localWrite.mtimeFor(path, remote.lastModified || undefined),
        writeCreationTimeMs(before?.ctime, remote.creationTime),
      );
      this.deps.localWrite.written(path);
    } catch (err) {
      this.deps.journal.recordError(summary, path, err);
      this.deps.queueRetry(path);
      void this.deps.logger?.log(`conflict: prefer-remote write failed (${(err as Error).message}); queued retry → ${path}`);
      return;
    }
    const localHash = await sha256(remoteData);
    const mtime = remote.lastModified || (await this.deps.localAdapter.stat(path))?.mtime || Date.now();
    summary.downloadedCount++;
    this.deps.journal.recordHistory(path, 'remote-wins', undefined, {
      localHash, remoteId, remoteIdType: idType,
      localSize: remoteData.byteLength, remoteSize: remote.size,
    });
    this.deps.stateDB.setFile(await withLocalSignature(this.deps.localAdapter, {
      path, localHash, remoteId, idType,
      size: remote.size, mtime,
      remoteFileId: remote.fileId, isConflicted: false,
    }, remote.lastModified));
    this.deps.mergeBase.recordBytes(path, remoteData);
    if (client) await this.deps.creationTime?.align(client, remote);
    void this.deps.logger?.log(`conflict: resolved by prefer-remote (local overwritten) → ${path}`);
  }
}
