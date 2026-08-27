// Remote enumeration lifted out of SyncEngine (feature 074, Phase 2).
//
// Produces the remote side of a full scan: either a real listing, or the same listing rebuilt from
// State when the vault root ETag proves nothing changed. Both forms are complete, which is what lets
// the caller treat them identically.
//
// The WebDAV client is a PARAMETER on every method, never a field. SyncEngine creates it lazily and
// can replace it (ensureClient), so a source that captured one at construction would keep talking to
// a client the engine has already moved on from.
import { RemoteFileInfo, RemoteDirInfo } from '../../types';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { FORCE_FULL_SCAN_EVERY } from '../../util/limits';
import { FileLogger } from '../../util/FileLogger';

/**
 * What the listing source needs. `isNextcloud` and `networkConcurrency` are accessors because both
 * change during an engine's life — capabilities arrive on connect, settings can be edited — and a
 * captured value would go stale without anything failing loudly.
 */
export interface RemoteListingDeps {
  stateDB: Pick<StateDB,
    'getAllFiles' | 'getAllDirs' | 'getRemoteRootEtag' | 'setRemoteRootEtag'
    | 'getFullScanSkipCount' | 'setFullScanSkipCount'>;
  /** Whether the connected server is a Nextcloud — the root-ETag shortcut exists nowhere else. */
  isNextcloud(): boolean;
  /**
   * Configured parallelism for the on-demand checksum pass. Callers are expected to floor the raw
   * setting (which exposes 0), but the batching loop below floors it again: it advances by this
   * value, so a 0 arriving here would not be slow — it would never terminate.
   */
  networkConcurrency(): number;
  logger?: Pick<FileLogger, 'log'>;
}

export class RemoteListingSource {
  constructor(private readonly deps: RemoteListingDeps) {}

  /**
   * Root-ETag short-circuit (spec 023). Obtain the COMPLETE remote file listing for a full scan,
   * either by a real Depth:infinity PROPFIND (`getFiles('')`) or — when this is Nextcloud and the
   * vault root ETag is unchanged since the last REAL scan — by rebuilding it from State, skipping the
   * heavy listing. Returns the rebuilt directory list too (non-null only when short-circuited) so
   * reconcileDirectories can likewise skip getDirectories('').
   *
   * Safety: the rebuilt listing is COMPLETE (every tracked file/dir), so it flows through the normal
   * full-scan path unchanged — absence-based remote-deletion, the mass-delete breaker, conflict
   * resolution and uploads are all untouched. The stored root ETag is updated ONLY on a real scan, so
   * a local upload/delete/rename (which changes the remote root ETag) forces a real scan next time.
   */
  async obtainFullScanListing(
    client: IWebDAVClient,
  ): Promise<{ remoteFiles: RemoteFileInfo[]; cachedDirs: RemoteDirInfo[] | null }> {
    const db = this.deps.stateDB;
    const isNextcloud = this.deps.isNextcloud();
    const stored = db.getRemoteRootEtag();
    const skipCount = db.getFullScanSkipCount();
    const forced = skipCount >= FORCE_FULL_SCAN_EVERY;

    // Capture the current root ETag BEFORE listing so a real scan never stores a value NEWER than its
    // listing: any remote change interleaving here yields a mismatch next sync (an extra real scan,
    // never a missed change). Nextcloud only — getRootEtag() is null elsewhere (no short-circuit).
    const cur = isNextcloud ? await client.getRootEtag() : null;

    if (cur != null && stored != null && cur === stored && !forced) {
      const remoteFiles = this.rebuildRemoteFilesFromState();
      const cachedDirs = this.rebuildRemoteDirsFromState();
      db.setFullScanSkipCount(skipCount + 1);
      void this.deps.logger?.log(
        `sync: root-ETag MATCH (${cur}) → SHORT-CIRCUIT full scan; rebuilt ${remoteFiles.length} files / ${cachedDirs.length} dirs from State (skip ${skipCount + 1}/${FORCE_FULL_SCAN_EVERY})`,
      );
      return { remoteFiles, cachedDirs };
    }

    // Real full scan. Persist the captured root ETag (may be null on non-Nextcloud / fetch failure →
    // next sync simply real-scans again) and reset the skip budget.
    const remoteFiles = await client.getFiles('');
    db.setRemoteRootEtag(cur);
    db.setFullScanSkipCount(0);
    void this.deps.logger?.log(
      `sync: REAL full scan (remote=${remoteFiles.length}); rootEtag=${cur ?? 'null'}${forced ? ' (forced: skip budget reached)' : ''}`,
    );
    return { remoteFiles, cachedDirs: null };
  }

  /** Rebuild the remote file listing from State (root-ETag short-circuit). Every entry must read as
   *  "remote unchanged" against its own base: effective id = checksum ?? etag ?? size = remoteId. */
  rebuildRemoteFilesFromState(): RemoteFileInfo[] {
    return this.deps.stateDB.getAllFiles().map((fs) => ({
      path: fs.path,
      fileId: fs.remoteFileId,
      checksum: fs.idType === 'sha256' ? fs.remoteId : null,
      etag: fs.idType === 'etag' ? fs.remoteId : null,
      size: fs.size,
      lastModified: fs.remoteMtime ?? fs.mtime,
    }));
  }

  /** Rebuild the remote directory listing from State (root-ETag short-circuit). reconcileDirectories
   *  only needs path/fileId; etag/lastModified are unused there. */
  rebuildRemoteDirsFromState(): RemoteDirInfo[] {
    return this.deps.stateDB.getAllDirs().map((d) => ({
      path: d.path,
      fileId: d.remoteFileId,
      etag: null,
      lastModified: 0,
    }));
  }

  /**
   * For files that exist on both sides but whose server-side checksum is not yet stored,
   * ask the server to compute SHA-256 on demand (no download; Nextcloud ChecksumUpdatePlugin).
   * Best-effort and bounded-parallel: clients/servers without support leave the checksum null,
   * which makes buildInitialPlan fall back to content-based conflict resolution.
   */
  async resolveRemoteChecksums(
    client: IWebDAVClient,
    remoteFiles: RemoteFileInfo[],
    localFiles: Map<string, { size: number; mtime: number }>,
  ): Promise<void> {
    const targets = remoteFiles.filter(rf => !rf.checksum && localFiles.has(rf.path));
    const concurrency = Math.max(1, this.deps.networkConcurrency());
    for (let i = 0; i < targets.length; i += concurrency) {
      const batch = targets.slice(i, i + concurrency);
      await Promise.all(batch.map(async (rf) => {
        try {
          const sum = await client.recalcChecksum(rf.path);
          if (sum) rf.checksum = sum;
        } catch { /* leave null; falls back to conflict resolution */ }
      }));
    }
  }
}
