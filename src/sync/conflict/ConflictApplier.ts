// Conflict application, lifted out of SyncEngine (feature 074, Phase 6).
//
// ConflictResolver DECIDES what should happen to a diverged file; this module CARRIES IT OUT. The
// split already existed — the resolver has always been pure, with no I/O — but the acting half lived
// inside the engine, which made the two halves look like one thing.
//
// The four outcomes it applies (write / prefer-local / prefer-remote, plus the two that deliberately
// do nothing) share a property worth stating once: none of them may report success it did not
// achieve. A failed push must leave the file conflicted and the previous baseline intact, because a
// state that pairs the new local hash with the old remote id reads as "converged" to the next sync
// and the merge then never reaches the other devices.
//
// This is called BY the sync loop and never calls back into it, which is what makes it extractable.
import {
  FileState, RemoteFileInfo, SyncSessionSummary, SyncHistoryDetail, ConflictResolution,
  FileLockedError,
} from '../../types';
import { LocalAdapter } from '../../data/LocalAdapter';
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
import type { App } from 'obsidian';

/** The connected server. Resolved by the caller: both are created lazily and can be replaced. */
export interface Connection {
  client: IWebDAVClient;
  uploadStrategy: IUploadStrategy;
}

export interface ConflictDeps {
  app: App;
  localAdapter: LocalAdapter;
  stateDB: Pick<StateDB, 'getFile' | 'setFile' | 'setRemoteRootEtag'>;
  baseStore?: Pick<MergeBaseStore, 'get'>;
  journal: SyncJournal;
  mergeBase: MergeBaseRecorder;
  transfer: TransferService;
  /** Only for capturing the clean sides before a marker write (feature 044). */
  resolution: Pick<ResolutionService, 'captureCleanSides'>;
  /** The strategy configuration, read at call time so a settings change takes effect. */
  resolverConfig(): MergeConfig;
  maxFileSizeMB(): number;
  /** Outbound port: this path needs another attempt later in the session. */
  queueRetry(path: string): void;
  /** Outbound port: a conflict was reached. Lets the watch path notice one settled (C-6). */
  onConflictEncountered(): void;
  logger?: Pick<FileLogger, 'log'>;
}

export class ConflictApplier {
  constructor(private readonly deps: ConflictDeps) {}

  async handleConflict(
    conn: Connection,
    path: string, base: FileState | undefined, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    this.deps.onConflictEncountered(); // C-6: lets the watch path notice a conflict settled without a counter
    // Size guard (spec 035, FR-010): a both-sides conflict needs the remote body to merge, but an
    // oversized remote cannot be fetched without risking OOM. Skip the download, keep local untouched,
    // and flag the file conflicted so the UI surfaces it. Do NOT queue a retry — re-fetching would
    // fail the same way every sync until the cap is raised; raising it lets the next sync merge
    // normally (self-healing). Leave the StateDB Base hashes untouched so the divergence persists.
    if (this.deps.transfer.isRemoteOverSizeLimit(remote)) {
      this.deps.transfer.warnDownloadSkipped(path, remote.size);
      if (base) this.deps.stateDB.setFile({ ...base, isConflicted: true });
      void this.deps.logger?.log(`conflict: remote over size limit (${remote.size}B > ${this.deps.maxFileSizeMB()}MB), skipped → ${path}`);
      return;
    }

    // Capture local stat (size + mtime) BEFORE writing any merge result: needed both for the
    // max(local, remote) mtime stamp on a merge write and for the biggest-size / latest-mtime
    // deterministic strategies (feature 037).
    const localStatBefore = await this.deps.localAdapter.stat(path);
    const localMtimeBefore = localStatBefore?.mtime ?? 0;
    const localSizeBefore = localStatBefore?.size ?? 0;

    // Feature 037: a single per-type strategy replaces the former three conflict settings. The
    // ConflictResolver classifies the path (Auto Merge File / Other File) and applies its strategy.
    // Config-folder JSON (appearance.json, etc.) has no special branch any more: its extension is not
    // in autoMergeFileTypes, so it falls to `otherFileStrategy` (default latest-mtime = newest-wins),
    // which never writes markers — JSON-safe, single path (FR-013).
    const resolver = new ConflictResolver(this.deps.app, this.deps.localAdapter, this.deps.resolverConfig());
    const ctx = {
      localSize: localSizeBefore,
      remoteSize: remote.size,
      localMtime: localMtimeBefore,
      remoteMtime: remote.lastModified || 0,
    };

    // The `merge` strategy needs the decoded text of both sides; so does EVERY markdown file (feature
    // 047), which splits frontmatter from body and resolves them independently regardless of the body
    // strategy. Non-markdown deterministic strategies decide from size/mtime alone, so defer their
    // remote download until we know it is required.
    let remoteData: ArrayBuffer | undefined;
    let decision: ConflictResolution;
    if (resolver.strategyFor(path) === 'merge' || isMarkdown(path)) {
      const localContent = await this.deps.localAdapter.read(path);
      remoteData = await conn.client.downloadFile(remote.path);
      const remoteContent = new TextDecoder().decode(remoteData);
      // Feature 038: pass the stored common ancestor (last-synced body) as the 3-way merge base so
      // reconcile does not duplicate blocks both sides share. Empty when no base is known yet
      // (migration / first conflict); the expansion guard (037) then prevents a corrupt write and the
      // next convergence seeds the base (self-healing).
      const mergeBaseContent = this.deps.baseStore?.get(path) ?? '';
      // Feature 041: a lone half-marker left by an incomplete manual resolution used to trap the file
      // in a permanent safe-hold (never pushed → the orphan line survived on the server → re-conflict
      // every sync). It is now merged normally and self-heals; record that we bypassed the re-entrancy
      // guard so the recovery is visible in the debug log.
      if (hasOrphanMarker(localContent) || hasOrphanMarker(remoteContent)) {
        void this.deps.logger?.log(`conflict: orphan marker detected, bypassing re-entrancy guard (self-heal) → ${path}`);
      }
      decision = resolver.decide(path, mergeBaseContent, localContent, remoteContent, ctx);
      // Feature 044: a marker write (clean:false) is the ONLY resolution that overwrites both clean
      // sides (local body on disk + remote body on the server). Capture them NOW — before the switch
      // runs resolveByWrite — so force-resolution can later recover a real clean version instead of the
      // marker content. Clean auto-merges (clean:true) and the deterministic strategies capture nothing.
      if (decision.action === 'write' && !decision.clean) {
        this.deps.resolution.captureCleanSides(path, localContent, remoteContent, localMtimeBefore, localSizeBefore, remote);
      }
    } else {
      decision = resolver.decide(path, '', '', '', ctx);
    }

    switch (decision.action) {
      case 'safe-hold':
        // Non-text file under the merge strategy (FR-005a): writing conflict markers would corrupt
        // it, so leave BOTH sides untouched and only flag the entry conflicted. NOT an error and NOT
        // retried; the StateDB Base hashes stay as-is so the divergence persists for manual resolution.
        if (base) this.deps.stateDB.setFile({ ...base, isConflicted: true });
        summary.conflictedCount++;
        this.deps.journal.recordHistory(path, 'conflicted');
        void this.deps.logger?.log(`conflict: non-text under merge → safe-hold, both sides untouched → ${path}`);
        return;

      case 'no-op':
        // Deterministic tie — equal size (biggest-size) or equal mtime (latest-mtime) — FR-009: leave
        // BOTH sides untouched, do NOT flag conflicted, do NOT count an error. The next sync
        // re-evaluates once either side changes (self-healing); the StateDB is left untouched.
        void this.deps.logger?.log(`conflict: deterministic tie → no-op, both sides untouched → ${path}`);
        // Root-ETag short-circuit safety (spec 023 §8a.5): a tie deliberately leaves the two sides
        // DIVERGENT (local ≠ remote) with the StateDB untouched and nothing pushed — so the remote root
        // ETag is unchanged and no summary counter rises. Unlike the conflicted / error / retry
        // outcomes, finalizeScan's convergence gate cannot see this standing divergence. If the
        // short-circuit stayed armed, the next sync would rebuild the remote listing from the stale
        // StateDB, misread the tie as a local-only change, and silently upload the local side —
        // overwriting the other device's edit (data loss). Force a real scan next time so the tie is
        // re-detected. Self-healing: once a real scan converges, it re-arms the short-circuit.
        this.deps.stateDB.setRemoteRootEtag(null);
        return;

      case 'prefer-local':
        await this.resolveByPreferLocal(conn, path, remote, summary);
        return;

      case 'prefer-remote':
        if (!remoteData) remoteData = await conn.client.downloadFile(remote.path);
        await this.resolveByPreferRemote(path, remote, remoteData, remoteId, idType, summary);
        return;

      case 'write':
        await this.resolveByWrite(conn, path, decision.content, decision.clean, remote, remoteId, idType, localMtimeBefore, summary);
        return;
    }
  }

  /** 'write' action: write merged/marker content locally, then push it to the server to converge. */
  async resolveByWrite(
    conn: Connection,
    path: string, content: string, clean: boolean, remote: RemoteFileInfo,
    remoteId: string, idType: FileState['idType'], localMtimeBefore: number, summary: SyncSessionSummary,
  ): Promise<void> {
    await this.deps.localAdapter.atomicWrite(path, content);

    // Apply max(local, remote) mtime to the local file.
    // Remote mtime update via PROPPATCH is not supported on Nextcloud (live property, silently ignored);
    // X-OC-MTime on upload already handles mtime for newly uploaded files.
    const maxMtime = Math.max(localMtimeBefore, remote.lastModified || 0) || Date.now();
    await this.deps.localAdapter.setMtime(path, maxMtime);

    // Push the merged result back to the server so BOTH sides converge. Without this the merge stays
    // local-only: the server keeps the old remote copy, every later sync re-detects the same conflict,
    // and the merge never reaches other devices.
    const mergedData = await this.deps.localAdapter.readBinary(path);
    const mergedHash = await sha256(mergedData);
    let uploaded = false;
    try {
      const lockToken = await this.deps.transfer.acquireLock(conn.client, path);
      try {
        const outcome = await conn.uploadStrategy.upload(conn.client, path, mergedData, maxMtime);
        if (outcome !== 'skipped') { summary.uploadedCount++; uploaded = true; this.deps.journal.recordHistory(path, 'uploaded'); }
      } finally {
        await this.deps.transfer.releaseLock(conn.client, path, lockToken);
      }
    } catch (err) {
      // Locked by someone else or a transient failure → keep the conflict and retry next sync.
      this.deps.queueRetry(path);
      if (!(err instanceof FileLockedError)) {
        void this.deps.logger?.log(`conflict: merge upload failed (${(err as Error).message}); queued retry → ${path}`);
      }
    }

    const stat = await this.deps.localAdapter.stat(path);
    const prior = this.deps.stateDB.getFile(path);
    const nextState: FileState = {
      path,
      // Claiming the merged body as the local baseline is only truthful once it reached the server.
      // Feature 063: when the push failed, recording it here made the NEXT sync read "local
      // unchanged + remote unchanged" and take the converged arm — which even clears isConflicted —
      // so the merge stayed local forever and never reached the other devices. The G1-1 flag alone
      // cannot prevent that (nothing consumes it on the converged arm). Keeping the previous
      // baseline instead leaves a genuine local change for the next sync to detect and re-push.
      localHash: uploaded ? mergedHash : (prior?.localHash ?? ''),
      // When the merged content is on the server, record it as the synced remote id so the next sync
      // sees both sides as identical (converged) instead of re-detecting the conflict.
      remoteId: uploaded ? mergedHash : remoteId,
      idType: uploaded ? 'sha256' : idType,
      size: stat?.size ?? 0, mtime: maxMtime,
      remoteFileId: remote.fileId,
      // BUG G1-1 fix: isConflicted must also stay true when the upload failed, even for a clean
      // merge — remoteId/idType above are already gated on `uploaded`; without this the committed
      // state pairs the OLD remoteId with the NEW localHash and isConflicted:false, which the next
      // sync reads as "converged" and never retries pushing the merge result.
      isConflicted: !clean || !uploaded,
    };
    // Stamp the post-write stat signature ONLY when the state describes the body actually on disk.
    // After a failed push the recorded localHash deliberately differs from the file, so a signature
    // would let the local-unchanged fast path skip the re-hash that drives the retry.
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
      // Feature 038: a clean merge that reached the server means both sides now hold the merged
      // content → it is the new common ancestor. If the upload failed (retry queued), the sides have
      // NOT converged yet, so do not advance the base.
      if (uploaded) this.deps.mergeBase.record(path, content);
    } else {
      summary.conflictedCount++;
      this.deps.journal.recordHistory(path, 'conflicted', undefined, mergeDetail);
    }
    void this.deps.logger?.log(`conflict: ${clean ? 'auto-merged clean' : 'wrote conflict markers'}, uploaded=${uploaded} → ${path}`);
  }

  /** 'local-wins' action: overwrite the remote with the local copy. On failure, do NOT mark resolved. */
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
        const outcome = await conn.uploadStrategy.upload(conn.client, path, localData, mtime);
        if (outcome === 'skipped') {
          // Size limit etc.: leave the conflict for the user; do not mark resolved.
          this.deps.queueRetry(path);
          return;
        }
      } finally {
        await this.deps.transfer.releaseLock(conn.client, path, lockToken);
      }
    } catch (err) {
      // Upload failed → keep the conflict unresolved and retry next sync (never mark converged).
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
    // Feature 038: both sides now hold the local body → it is the new merge base.
    this.deps.mergeBase.record(path, new TextDecoder().decode(localData));
    void this.deps.logger?.log(`conflict: resolved by prefer-local (remote overwritten) → ${path}`);
  }

  /** 'remote-wins' action: overwrite the local with the remote copy. */
  async resolveByPreferRemote(
    path: string, remote: RemoteFileInfo, remoteData: ArrayBuffer,
    remoteId: string, idType: FileState['idType'], summary: SyncSessionSummary,
  ): Promise<void> {
    // Server-anomaly guard (spec 025): never overwrite local with a body whose length disagrees with
    // the advertised remote size (0-byte / truncated). Keep the conflict unresolved and retry.
    if (isAnomalousRemoteContent(remote.size, remoteData.byteLength)) {
      this.deps.journal.recordError(summary, path, new Error(`Refused prefer-remote overwrite: advertised ${remote.size} bytes but body is ${remoteData.byteLength} (server anomaly)`));
      this.deps.queueRetry(path);
      void this.deps.logger?.log(`conflict: prefer-remote REFUSED anomalous remote (size ${remote.size}≠${remoteData.byteLength}) → kept local, queued retry → ${path}`);
      return;
    }
    try {
      await this.deps.localAdapter.atomicWriteBinary(path, remoteData);
      if (remote.lastModified) {
        await this.deps.localAdapter.setMtime(path, remote.lastModified);
      }
    } catch (err) {
      // Local write failed → keep the conflict unresolved and retry next sync.
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
    // Feature 038: both sides now hold the remote body → it is the new merge base.
    this.deps.mergeBase.record(path, new TextDecoder().decode(remoteData));
    void this.deps.logger?.log(`conflict: resolved by prefer-remote (local overwritten) → ${path}`);
  }
}
