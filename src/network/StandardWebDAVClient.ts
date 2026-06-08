import { requestUrl } from 'obsidian';
import {
  NextcloudFeatures,
  RemoteFileInfo,
  SyncChanges,
  NetworkError,
  SyncTokenExpiredError,
  ConflictError,
} from '../types';
import { IWebDAVClient } from './IWebDAVClient';
import { DavSyncSettings } from '../types';

export class StandardWebDAVClient implements IWebDAVClient {
  constructor(
    private readonly settings: DavSyncSettings,
    private readonly appPassword: string,
  ) {}

  private get baseUrl(): string {
    return this.settings.serverUrl.replace(/\/$/, '');
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
    const url = `${this.baseUrl}/${path}`;
    const res = await requestUrl({
      url,
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`,
      throw: false,
    });
    if (res.status !== 207) throw new NetworkError(res.status, res.text);
    return this.parsePropfindResponse(res.text);
  }

  async getChanges(_syncToken: string): Promise<SyncChanges> {
    // Standard WebDAV doesn't support sync-collection
    throw new SyncTokenExpiredError();
  }

  async downloadFile(remotePath: string, _localTmpPath: string): Promise<void> {
    const url = `${this.baseUrl}/${remotePath}`;
    const res = await requestUrl({ url, method: 'GET', headers: { Authorization: this.authHeader }, throw: false });
    if (res.status !== 200) throw new NetworkError(res.status, '');
    (this as Record<string, unknown>)._lastDownload = res.arrayBuffer;
  }

  getLastDownloadBuffer(): ArrayBuffer {
    return (this as Record<string, unknown>)._lastDownload as ArrayBuffer ?? new ArrayBuffer(0);
  }

  async uploadFile(remotePath: string, data: ArrayBuffer): Promise<void> {
    const url = `${this.baseUrl}/${remotePath}`;
    const res = await requestUrl({ url, method: 'PUT', headers: { Authorization: this.authHeader }, body: data, throw: false });
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async moveFile(oldPath: string, newPath: string): Promise<void> {
    const src = `${this.baseUrl}/${oldPath}`;
    const dest = `${this.baseUrl}/${newPath}`;
    const res = await requestUrl({ url: src, method: 'MOVE', headers: { Authorization: this.authHeader, Destination: dest, Overwrite: 'F' }, throw: false });
    if (res.status === 412) throw new ConflictError(newPath);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async deleteFile(path: string, _expectedRemoteId: string): Promise<void> {
    const url = `${this.baseUrl}/${path}`;
    const res = await requestUrl({ url, method: 'DELETE', headers: { Authorization: this.authHeader }, throw: false });
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async getSyncToken(): Promise<string | null> {
    return null;
  }

  private parsePropfindResponse(xml: string): RemoteFileInfo[] {
    const results: RemoteFileInfo[] = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    for (let i = 0; i < responses.length; i++) {
      const resp = responses[i];
      const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
      const prop = resp.getElementsByTagNameNS('DAV:', 'prop')[0];
      if (!prop) continue;
      const resourcetype = prop.getElementsByTagNameNS('DAV:', 'resourcetype')[0];
      if (resourcetype?.getElementsByTagNameNS('DAV:', 'collection').length > 0) continue;
      const etag = prop.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent?.replace(/"/g, '') ?? null;
      const size = parseInt(prop.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent ?? '0', 10);
      const lastModifiedStr = prop.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent ?? '';
      const lastModified = lastModifiedStr ? new Date(lastModifiedStr).getTime() : 0;
      const path = decodeURIComponent(href.split('/').slice(-1)[0]);
      results.push({ path, fileId: null, checksum: null, etag, size, lastModified });
    }
    return results;
  }
}
