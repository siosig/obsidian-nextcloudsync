import { requestUrl } from 'obsidian';
import {
  NextcloudFeatures,
  RemoteFileInfo,
  SyncChanges,
  FileVersion,
  NetworkError,
  SyncTokenExpiredError,
  ConflictError,
  FeatureUnsupportedError,
} from '../types';
import { IWebDAVClient } from './IWebDAVClient';
import { DavSyncSettings } from '../types';
import { toRemotePath, hrefToRelative, encodeRemoteUrl, ensureRemoteDir } from './remotePath';

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
    return this.settings.serverUrl.replace(/\/$/, '');
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

  async connect(): Promise<NextcloudFeatures> {
    // Standard WebDAV: just verify connectivity
    const res = await requestUrl({
      url: this.baseUrl,
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '0' },
      throw: false,
    });
    if (res.status !== 207 && res.status !== 200) throw new NetworkError(res.status, res.text);
    return { isNextcloud: false, version: '', hasChecksums: false, hasFilesLocking: false, syncToken: null };
  }

  async getFiles(path: string): Promise<RemoteFileInfo[]> {
    // Many standard WebDAV servers disallow Depth:infinity, so recurse with Depth:1 to traverse the entire tree.
    const results: RemoteFileInfo[] = [];
    await this.propfindRecursive(path, results, new Set());
    return results;
  }

  /** Fetches a single collection with Depth:1, collecting files while recursing into subcollections. */
  private async propfindRecursive(rel: string, out: RemoteFileInfo[], visited: Set<string>): Promise<void> {
    if (visited.has(rel)) return; // Guard against self-reference and cycles
    visited.add(rel);
    const res = await requestUrl({
      url: this.remoteUrl(rel),
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`,
      throw: false,
    });
    // A missing folder (e.g. before the first sync) returns 404. Treat it as empty.
    if (res.status === 404) return;
    if (res.status !== 207) throw new NetworkError(res.status, res.text);
    const { files, folders } = this.parseListing(res.text, rel);
    out.push(...files);
    for (const folder of folders) {
      await this.propfindRecursive(folder, out, visited);
    }
  }

  async getChanges(_syncToken: string): Promise<SyncChanges> {
    // Standard WebDAV doesn't support sync-collection
    throw new SyncTokenExpiredError();
  }

  async downloadFile(remotePath: string, _localTmpPath: string): Promise<void> {
    const res = await requestUrl({ url: this.remoteUrl(remotePath), method: 'GET', headers: { Authorization: this.authHeader }, throw: false });
    if (res.status !== 200) throw new NetworkError(res.status, '');
    (this as Record<string, unknown>)._lastDownload = res.arrayBuffer;
  }

  getLastDownloadBuffer(): ArrayBuffer {
    return (this as Record<string, unknown>)._lastDownload as ArrayBuffer ?? new ArrayBuffer(0);
  }

  async recalcChecksum(_remotePath: string): Promise<string | null> {
    // Server-side checksum computation is a Nextcloud extension; not available on plain WebDAV.
    // Returning null makes the initial sync fall back to content-based conflict resolution.
    return null;
  }

  async setMtime(remotePath: string, mtime: number): Promise<void> {
    const rfcDate = new Date(mtime).toUTCString();
    await requestUrl({
      url: this.remoteUrl(remotePath),
      method: 'PROPPATCH',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:getlastmodified>${rfcDate}</d:getlastmodified></d:prop></d:set></d:propertyupdate>`,
      throw: false,
    });
  }

  async uploadFile(remotePath: string, data: ArrayBuffer): Promise<void> {
    await ensureRemoteDir({ baseUrl: this.baseUrl, authHeader: this.authHeader }, toRemotePath(this.remoteBase, remotePath), this.createdDirs);
    const res = await requestUrl({ url: this.remoteUrl(remotePath), method: 'PUT', headers: { Authorization: this.authHeader }, body: data, throw: false });
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async moveFile(oldPath: string, newPath: string): Promise<void> {
    await ensureRemoteDir({ baseUrl: this.baseUrl, authHeader: this.authHeader }, toRemotePath(this.remoteBase, newPath), this.createdDirs);
    const res = await requestUrl({ url: this.remoteUrl(oldPath), method: 'MOVE', headers: { Authorization: this.authHeader, Destination: this.remoteUrl(newPath), Overwrite: 'F' }, throw: false });
    if (res.status === 412) throw new ConflictError(newPath);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async deleteFile(path: string, _expectedRemoteId: string): Promise<void> {
    const res = await requestUrl({ url: this.remoteUrl(path), method: 'DELETE', headers: { Authorization: this.authHeader }, throw: false });
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async getSyncToken(): Promise<string | null> {
    return null;
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

  async uploadChunked(_remotePath: string, _data: ArrayBuffer, _chunkSizeBytes: number): Promise<void> {
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
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    for (let i = 0; i < responses.length; i++) {
      const resp = responses[i];
      const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
      const prop = resp.getElementsByTagNameNS('DAV:', 'prop')[0];
      if (!prop) continue;
      const rel = this.hrefToRel(href);
      if (rel === null || rel === '' || rel === requestRel) continue; // Skip entries outside the base or the collection itself
      const resourcetype = prop.getElementsByTagNameNS('DAV:', 'resourcetype')[0];
      const isCollection = (resourcetype?.getElementsByTagNameNS('DAV:', 'collection').length ?? 0) > 0;
      if (isCollection) {
        folders.push(rel);
        continue;
      }
      const etag = prop.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent?.replace(/"/g, '') ?? null;
      const size = parseInt(prop.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent ?? '0', 10);
      const lastModifiedStr = prop.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent ?? '';
      const lastModified = lastModifiedStr ? new Date(lastModifiedStr).getTime() : 0;
      files.push({ path: rel, fileId: null, checksum: null, etag, size, lastModified });
    }
    return { files, folders };
  }

  /** Converts an href from a PROPFIND response into a Vault-relative path (see {@link hrefToRelative}). */
  private hrefToRel(href: string): string | null {
    return hrefToRelative(this.baseUrl, this.remoteBase, href);
  }
}
