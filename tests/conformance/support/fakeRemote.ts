// In-memory IWebDAVClient for SyncEngine conformance tests. Shared across multiple
// engines (devices) to model a single Nextcloud folder. getSyncToken returns null
// (mirrors this server's REPORT-415 reality), so the engine always full-scans via
// getFiles — no getChanges modelling needed.
import {
  IWebDAVClient,
} from '../../../src/network/IWebDAVClient';
import {
  NextcloudFeatures, RemoteFileInfo, SyncChanges, FileVersion, PreconditionFailedError,
} from '../../../src/types';
import { sha256 } from '../../../src/util/hash';

interface RemoteEntry {
  data: ArrayBuffer;
  etag: string;
  fileId: string;
  checksum: string;
  lastModified: number;
}

export class FakeRemote implements IWebDAVClient {
  /** path → entry. Public for test assertions. */
  readonly files = new Map<string, RemoteEntry>();
  private counter = 1;
  private fileIdCounter = 1;

  async connect(): Promise<NextcloudFeatures> {
    return { isNextcloud: true, version: '33.0.4', hasChecksums: true, hasFilesLocking: false, hasBulkUpload: false, syncToken: null };
  }

  async getFiles(_path: string): Promise<RemoteFileInfo[]> {
    return [...this.files.entries()].map(([path, e]) => ({
      path, fileId: e.fileId, checksum: e.checksum, etag: e.etag, size: e.data.byteLength, lastModified: e.lastModified,
    }));
  }

  async getChanges(_token: string): Promise<SyncChanges> {
    // Not used: getSyncToken returns null so the engine always full-scans.
    return { modified: await this.getFiles(''), deleted: [], newSyncToken: '' };
  }

  async downloadFile(remotePath: string): Promise<ArrayBuffer> {
    const e = this.files.get(remotePath);
    if (!e) throw Object.assign(new Error('HTTP 404'), { status: 404 });
    return e.data;
  }

  async uploadFile(
    remotePath: string, data: ArrayBuffer, mtime?: number,
    opts?: { precomputedSha256?: string; ifMatchEtag?: string | null },
  ): Promise<void> {
    const existing = this.files.get(remotePath);
    if (opts?.ifMatchEtag != null) {
      const want = opts.ifMatchEtag.replace(/^"|"$/g, '');
      const have = existing?.etag.replace(/^"|"$/g, '');
      if (!existing || want !== have) throw new PreconditionFailedError(remotePath);
    }
    const checksum = opts?.precomputedSha256 ?? await sha256(data);
    this.counter += 1;
    this.files.set(remotePath, {
      data,
      etag: `etag-${this.counter}`,
      fileId: existing?.fileId ?? `fid-${this.fileIdCounter++}`,
      checksum,
      lastModified: mtime ?? Date.now(),
    });
  }

  async uploadChunked(remotePath: string, data: ArrayBuffer, _chunkSizeBytes: number): Promise<void> {
    await this.uploadFile(remotePath, data);
  }

  async moveFile(oldPath: string, newPath: string): Promise<void> {
    const e = this.files.get(oldPath);
    if (!e) throw Object.assign(new Error('HTTP 404'), { status: 404 });
    this.files.delete(oldPath);
    this.files.set(newPath, e); // fileId preserved (rename, not re-create)
  }

  async deleteFile(path: string, _expectedRemoteId: string): Promise<void> {
    this.files.delete(path); // 404 = success is implicit (no throw on missing)
  }

  async getSyncToken(): Promise<string | null> {
    return null; // mirrors the live server (sync-collection REPORT unsupported)
  }

  async remoteExists(remotePath: string): Promise<boolean> {
    return this.files.has(remotePath);
  }

  async recalcChecksum(remotePath: string): Promise<string | null> {
    return this.files.get(remotePath)?.checksum ?? null;
  }

  async listVersions(_fileId: string): Promise<FileVersion[]> { return []; }
  async getVersionContent(_v: FileVersion, _fileId: string): Promise<ArrayBuffer> { return new ArrayBuffer(0); }
  async restoreVersion(_v: FileVersion, _fileId: string): Promise<void> { /* no-op */ }
  async lockFile(_remotePath: string): Promise<string> { return 'lock-token'; }
  async unlockFile(_remotePath: string, _token: string): Promise<void> { /* no-op */ }
}
