// Produces the remote side of a full scan: a real listing, or the same listing rebuilt from State when the
// vault root ETag proves nothing changed (docs/spec.md §8a.5). Both are complete, so callers treat them alike.
// The WebDAV client is a PARAMETER on every method, never a field: SyncEngine creates it lazily and can
// replace it, so a captured one would go stale.
import { RemoteFileInfo, RemoteDirInfo } from '../../types';
import { StateDB } from '../../data/StateDB';
import { IWebDAVClient } from '../../network/IWebDAVClient';
import { FORCE_FULL_SCAN_EVERY } from '../../util/limits';
import { FileLogger } from '../../util/FileLogger';

// `isNextcloud` and `networkConcurrency` are accessors because both change during an engine's life
// (capabilities arrive on connect, settings can be edited).
export interface RemoteListingDeps {
  stateDB: Pick<StateDB,
    'getAllFiles' | 'getAllDirs' | 'getRemoteRootEtag' | 'setRemoteRootEtag'
    | 'getFullScanSkipCount' | 'setFullScanSkipCount'>;
  isNextcloud(): boolean;
  // The batching loop advances by this value, so it floors it again: a 0 would never terminate.
  networkConcurrency(): number;
  logger?: Pick<FileLogger, 'log'>;
}

export class RemoteListingSource {
  constructor(private readonly deps: RemoteListingDeps) {}

  // Returns cachedDirs only when short-circuited, so reconcileDirectories can skip getDirectories('').
  // The rebuilt listing is COMPLETE, so downstream deletion and conflict logic is unchanged. The stored root
  // ETag is updated ONLY on a real scan, so a local upload/delete/rename forces a real scan next time.
  async obtainFullScanListing(
    client: IWebDAVClient,
  ): Promise<{ remoteFiles: RemoteFileInfo[]; cachedDirs: RemoteDirInfo[] | null }> {
    const db = this.deps.stateDB;
    const isNextcloud = this.deps.isNextcloud();
    const stored = db.getRemoteRootEtag();
    const skipCount = db.getFullScanSkipCount();
    const forced = skipCount >= FORCE_FULL_SCAN_EVERY;

    // Captured BEFORE listing so a real scan never stores a value NEWER than its listing: an interleaved remote
    // change yields a mismatch next sync (an extra scan, never a missed change). Null off Nextcloud.
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

    // A null ETag (non-Nextcloud, or fetch failure) just makes the next sync real-scan again.
    const remoteFiles = await client.getFiles('');
    db.setRemoteRootEtag(cur);
    db.setFullScanSkipCount(0);
    void this.deps.logger?.log(
      `sync: REAL full scan (remote=${remoteFiles.length}); rootEtag=${cur ?? 'null'}${forced ? ' (forced: skip budget reached)' : ''}`,
    );
    return { remoteFiles, cachedDirs: null };
  }

  // Every entry must read as "remote unchanged" against its own base: effective id = checksum ?? etag ?? size = remoteId.
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

  // reconcileDirectories only needs path/fileId; etag/lastModified are unused there.
  rebuildRemoteDirsFromState(): RemoteDirInfo[] {
    return this.deps.stateDB.getAllDirs().map((d) => ({
      path: d.path,
      fileId: d.remoteFileId,
      etag: null,
      lastModified: 0,
    }));
  }

  // Asks the server to compute SHA-256 on demand (no download). Best-effort: unsupported servers leave the
  // checksum null, so buildInitialPlan falls back to content-based conflict resolution.
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
