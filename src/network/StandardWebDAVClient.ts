import { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { requestUrlWithTimeout } from './requestWithTimeout';
import { withRetry } from '../util/retry';
import {
  NextcloudFeatures,
  RemoteFileInfo,
  RemoteDirInfo,
  SyncChanges,
  FileVersion,
  NetworkError,
  SyncTokenExpiredError,
  ConflictError,
  FeatureUnsupportedError,
  PreconditionFailedError,
} from '../types';
import { IWebDAVClient } from './IWebDAVClient';
import { DavSyncSettings } from '../types';
import { toRemotePath, hrefToRelative, encodeRemoteUrl, encodeServerUrl, ensureRemoteDir } from './remotePath';
import { parseResponses, readHref, readProp, readIsCollection, readDavProps } from './dav/propfind';
import { NO_CACHE_HEADERS } from './noCacheHeaders';

export class StandardWebDAVClient implements IWebDAVClient {
  /** Remote directories already created via MKCOL (in-session cache). */
  private readonly createdDirs = new Set<string>();

  constructor(
    private readonly settings: DavSyncSettings,
    private readonly appPassword: string,
    /** Base folder for the remote sync target (usually the Vault name). Empty string means directly under the files root. */
    private readonly remoteBase: string = '',
  ) {}

  private get baseUrl(): string {
    // encodeServerUrl: the configured Server URL may end in a subfolder containing a space or
    // non-ASCII characters, and it is the base of every request URL (see remotePath.ts).
    return encodeServerUrl(this.settings.serverUrl.replace(/\/$/, ''));
  }

  /** Converts a Vault-relative path into a WebDAV URL under the base folder. */
  private remoteUrl(rel: string): string {
    return encodeRemoteUrl(this.baseUrl, toRemotePath(this.remoteBase, rel));
  }

  private get authHeader(): string {
    const credentials = `${this.settings.username}:${this.appPassword}`;
    const bytes = new TextEncoder().encode(credentials);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return `Basic ${btoa(binary)}`;
  }

  /** Configured WebDAV request timeout in ms (0 = unbounded). Read live so a settings change applies next request. */
  private get timeoutMs(): number {
    return (this.settings.networkTimeoutSeconds ?? 0) * 1000;
  }

  /** All WebDAV requests route through here so the configured Network timeout is always applied. */
  private req(params: RequestUrlParam): Promise<RequestUrlResponse> {
    return requestUrlWithTimeout(params, this.timeoutMs);
  }

  /** Read-only requests (PROPFIND/GET) retry up to 2x on a transient req() rejection (timeout, connection
   *  failure). req() only rejects when no HTTP response was received at all — any status code (incl.
   *  401/404) resolves normally and is handled by the caller, so every rejection reaching here is
   *  transient by construction; no error-type check is needed. */
  private reqReadonly(params: RequestUrlParam): Promise<RequestUrlResponse> {
    return withRetry(() => this.req(params), 2, 1000, () => true);
  }

  async connect(): Promise<NextcloudFeatures> {
    // Standard WebDAV: just verify connectivity
    const res = await this.reqReadonly({
      url: this.baseUrl,
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '0', ...NO_CACHE_HEADERS },
      throw: false,
    });
    if (res.status !== 207 && res.status !== 200) throw new NetworkError(res.status, res.text, 'PROPFIND');
    return { isNextcloud: false, version: '', hasChecksums: false, hasFilesLocking: false, hasBulkUpload: false, syncToken: null };
  }

  async getFiles(path: string): Promise<RemoteFileInfo[]> {
    // Many standard WebDAV servers disallow Depth:infinity, so recurse with Depth:1 to traverse the entire tree.
    const results: RemoteFileInfo[] = [];
    await this.propfindRecursive(path, results, new Set());
    return results;
  }

  /**
   * Feature 064 (C-0): remote state of ONE file via Depth:0, reusing {@link parseListing} so the
   * fields match what getFiles produces. `requestRel` is passed as '' ON PURPOSE: parseListing drops
   * the entry equal to it (the "self" collection when listing a folder), and here the self entry IS
   * the file we want. A collection lands in `folders`, never in `files`, so it yields null.
   */
  async statFile(remotePath: string): Promise<RemoteFileInfo | null> {
    const res = await this.reqReadonly({
      url: this.remoteUrl(remotePath),
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '0', 'Content-Type': 'application/xml', ...NO_CACHE_HEADERS },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`,
      throw: false,
    });
    if (res.status === 404) return null;
    if (res.status !== 207) throw new NetworkError(res.status, res.text, 'PROPFIND');
    const { files } = this.parseListing(res.text, '');
    return files[0] ?? null;
  }

  async getRootEtag(): Promise<string | null> {
    // Root-ETag short-circuit is Nextcloud-only: plain WebDAV does not guarantee that a child change
    // propagates to the parent/root collection's ETag, so returning null makes the engine always
    // perform a real full scan here (safe default — never a missed remote change).
    return null;
  }

  /** Fetches a single collection with Depth:1, collecting files while recursing into subcollections. */
  private async propfindRecursive(rel: string, out: RemoteFileInfo[], visited: Set<string>): Promise<void> {
    if (visited.has(rel)) return; // Guard against self-reference and cycles
    visited.add(rel);
    const res = await this.reqReadonly({
      url: this.remoteUrl(rel),
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '1', 'Content-Type': 'application/xml', ...NO_CACHE_HEADERS },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`,
      throw: false,
    });
    // A missing folder (e.g. before the first sync) returns 404. Treat it as empty.
    if (res.status === 404) return;
    if (res.status !== 207) throw new NetworkError(res.status, res.text, 'PROPFIND');
    const { files, folders } = this.parseListing(res.text, rel);
    out.push(...files);
    for (const folder of folders) {
      await this.propfindRecursive(folder, out, visited);
    }
  }

  async getDirectories(path: string): Promise<RemoteDirInfo[]> {
    const out: RemoteDirInfo[] = [];
    await this.dirsRecursive(path, out, new Set());
    return out;
  }

  /** Recurse with Depth:1, collecting subcollections (plain WebDAV may reject Depth:infinity). */
  private async dirsRecursive(rel: string, out: RemoteDirInfo[], visited: Set<string>): Promise<void> {
    if (visited.has(rel)) return;
    visited.add(rel);
    const res = await this.reqReadonly({
      url: this.remoteUrl(rel),
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '1', 'Content-Type': 'application/xml', ...NO_CACHE_HEADERS },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`,
      throw: false,
    });
    if (res.status === 404) return;
    if (res.status !== 207) throw new NetworkError(res.status, res.text, 'PROPFIND');
    const { folders } = this.parseListing(res.text, rel);
    for (const folder of folders) {
      out.push({ path: folder, fileId: null, etag: null, lastModified: 0 });
      await this.dirsRecursive(folder, out, visited);
    }
  }

  async isRemoteDirEmpty(path: string): Promise<boolean> {
    const res = await this.reqReadonly({
      url: this.remoteUrl(path),
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '1', 'Content-Type': 'application/xml', ...NO_CACHE_HEADERS },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
      throw: false,
    });
    if (res.status !== 207) return false; // conservative: never report empty unless the server is clear.
    const { files, folders } = this.parseListing(res.text, path);
    return files.length === 0 && folders.length === 0;
  }

  async createDirectory(path: string): Promise<void> {
    await ensureRemoteDir(
      { baseUrl: this.baseUrl, authHeader: this.authHeader, timeoutMs: this.timeoutMs },
      toRemotePath(this.remoteBase, `${path}/_`),
      this.createdDirs,
    );
  }

  async deleteCollection(path: string): Promise<void> {
    const res = await this.req({ url: this.remoteUrl(path), method: 'DELETE', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false });
    if (res.status === 404) return;
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'DELETE');
  }

  async getChanges(_syncToken: string): Promise<SyncChanges> {
    // Standard WebDAV doesn't support sync-collection
    throw new SyncTokenExpiredError();
  }

  async downloadFile(remotePath: string): Promise<ArrayBuffer> {
    const res = await this.reqReadonly({ url: this.remoteUrl(remotePath), method: 'GET', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false });
    if (res.status !== 200) throw new NetworkError(res.status, '', 'GET');
    return res.arrayBuffer;
  }

  async recalcChecksum(_remotePath: string): Promise<string | null> {
    // Server-side checksum computation is a Nextcloud extension; not available on plain WebDAV.
    // Returning null makes the initial sync fall back to content-based conflict resolution.
    return null;
  }

  async uploadFile(
    remotePath: string, data: ArrayBuffer, mtime?: number,
    opts?: { precomputedSha256?: string; ifMatchEtag?: string | null },
  ): Promise<void> {
    const headers: Record<string, string> = { Authorization: this.authHeader, ...NO_CACHE_HEADERS };
    if (mtime) headers['X-OC-MTime'] = String(Math.floor(mtime / 1000));
    if (opts?.ifMatchEtag) headers['If-Match'] = `"${opts.ifMatchEtag.replace(/^"|"$/g, '')}"`;
    // Reactive directory creation (P1-B): PUT first; MKCOL ancestors on a missing-parent, retry once.
    // Standard WebDAV returns 409; Nextcloud's files DAV returns 404 for a missing parent — handle both.
    let res = await this.req({ url: this.remoteUrl(remotePath), method: 'PUT', headers, body: data, throw: false });
    if (res.status === 409 || res.status === 404) {
      await ensureRemoteDir({ baseUrl: this.baseUrl, authHeader: this.authHeader, timeoutMs: this.timeoutMs }, toRemotePath(this.remoteBase, remotePath), this.createdDirs);
      res = await this.req({ url: this.remoteUrl(remotePath), method: 'PUT', headers, body: data, throw: false });
    }
    if (res.status === 412) throw new PreconditionFailedError(remotePath);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'PUT');
  }

  async moveFile(oldPath: string, newPath: string): Promise<void> {
    await ensureRemoteDir({ baseUrl: this.baseUrl, authHeader: this.authHeader, timeoutMs: this.timeoutMs }, toRemotePath(this.remoteBase, newPath), this.createdDirs);
    const res = await this.req({ url: this.remoteUrl(oldPath), method: 'MOVE', headers: { Authorization: this.authHeader, Destination: this.remoteUrl(newPath), Overwrite: 'F', ...NO_CACHE_HEADERS }, throw: false });
    if (res.status === 412) throw new ConflictError(newPath);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'MOVE');
  }

  async deleteFile(path: string, _expectedRemoteId: string): Promise<void> {
    const res = await this.req({ url: this.remoteUrl(path), method: 'DELETE', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false });
    if (res.status === 404) return; // blind delete (P1-B): already gone = success
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'DELETE');
  }

  async getSyncToken(): Promise<string | null> {
    return null;
  }

  async remoteExists(remotePath: string): Promise<boolean> {
    // Only a definitive 404 means "gone"; any other status is treated as "present" (conservative).
    try {
      const res = await this.reqReadonly({
        url: this.remoteUrl(remotePath),
        method: 'PROPFIND',
        headers: { Authorization: this.authHeader, Depth: '0', ...NO_CACHE_HEADERS },
        throw: false,
      });
      return res.status !== 404;
    } catch {
      return true;
    }
  }

  // ── Nextcloud-specific features are not supported on standard WebDAV ──

  async listVersions(_fileId: string): Promise<FileVersion[]> {
    throw new FeatureUnsupportedError('versions');
  }

  async getVersionContent(_version: FileVersion, _fileId: string): Promise<ArrayBuffer> {
    throw new FeatureUnsupportedError('versions');
  }

  async restoreVersion(_version: FileVersion, _fileId: string): Promise<void> {
    throw new FeatureUnsupportedError('versions');
  }

  async uploadChunked(
    _remotePath: string, _data: ArrayBuffer, _chunkSizeBytes: number,
    _opts?: { precomputedSha256?: string; ifMatchEtag?: string | null },
  ): Promise<void> {
    throw new FeatureUnsupportedError('chunked-upload');
  }

  async lockFile(_remotePath: string): Promise<string> {
    throw new FeatureUnsupportedError('file-locking');
  }

  async unlockFile(_remotePath: string, _token: string): Promise<void> {
    throw new FeatureUnsupportedError('file-locking');
  }

  /**
   * Parses a Depth:1 PROPFIND response and classifies entries into files and subfolders (both as Vault-relative paths).
   * Excludes the requested collection itself and any entries outside the base folder.
   * @param requestRel The Vault-relative path this PROPFIND was issued for (used to exclude the self entry)
   */
  private parseListing(xml: string, requestRel: string): { files: RemoteFileInfo[]; folders: string[] } {
    const files: RemoteFileInfo[] = [];
    const folders: string[] = [];
    for (const resp of parseResponses(xml)) {
      const prop = readProp(resp);
      if (!prop) continue;
      const rel = this.hrefToRel(readHref(resp));
      if (rel === null || rel === '' || rel === requestRel) continue; // Skip entries outside the base or the collection itself
      if (readIsCollection(prop)) {
        folders.push(rel);
        continue;
      }
      const { etag, size, lastModified } = readDavProps(prop);
      // A plain WebDAV server offers neither a checksum nor a file id: readOwncloudProps is not
      // called at all, rather than called and discarded.
      files.push({ path: rel, fileId: null, checksum: null, etag, size, lastModified });
    }
    return { files, folders };
  }

  /** Converts an href from a PROPFIND response into a Vault-relative path (see {@link hrefToRelative}). */
  private hrefToRel(href: string): string | null {
    return hrefToRelative(this.baseUrl, this.remoteBase, href);
  }
}
