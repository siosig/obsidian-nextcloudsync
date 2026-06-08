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
import { toRemotePath, fromRemotePath, encodeRemoteUrl, ensureRemoteDir } from './remotePath';

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:getetag/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <d:sync-token/>
    <oc:checksums/>
    <oc:fileid/>
  </d:prop>
</d:propfind>`;

const REPORT_BODY = (syncToken: string) => `<?xml version="1.0" encoding="utf-8" ?>
<d:sync-collection xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:sync-token>${syncToken}</d:sync-token>
  <d:sync-level>infinite</d:sync-level>
  <d:prop>
    <d:getetag/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <oc:checksums/>
    <oc:fileid/>
  </d:prop>
</d:sync-collection>`;

export class NextcloudClient implements IWebDAVClient {
  private features: NextcloudFeatures | null = null;
  /** MKCOL で作成済みのリモートディレクトリ（セッション内キャッシュ）。 */
  private readonly createdDirs = new Set<string>();

  constructor(
    private readonly settings: DavSyncSettings,
    private readonly appPassword: string,
    /** リモート同期先のベースフォルダ（通常は Vault 名）。空文字なら files ルート直下。 */
    private readonly remoteBase: string = '',
  ) {}

  private get baseUrl(): string {
    return this.settings.serverUrl.replace(/\/$/, '');
  }

  /** Vault 相対パスを、ベースフォルダ配下の WebDAV URL に変換する。 */
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
    // Check /status.php for maintenance mode
    const statusUrl = this.settings.serverUrl.replace(/\/remote\.php.*$/, '') + '/status.php';
    const statusRes = await requestUrl({ url: statusUrl, method: 'GET', throw: false });
    if (statusRes.status === 200) {
      const status = statusRes.json as Record<string, unknown>;
      if (status.maintenance === true) {
        throw new Error('Nextcloud is in maintenance mode');
      }
    }

    // Get capabilities
    const capUrl = this.settings.serverUrl.replace(/\/remote\.php.*$/, '') + '/ocs/v1.php/cloud/capabilities?format=json';
    const capRes = await requestUrl({
      url: capUrl,
      method: 'GET',
      headers: { Authorization: this.authHeader, 'OCS-APIRequest': 'true' },
      throw: false,
    });

    let version = '';
    let hasChecksums = false;

    if (capRes.status === 200) {
      const cap = capRes.json as Record<string, unknown>;
      const data = (cap as Record<string, Record<string, unknown>>).ocs?.data as Record<string, unknown> | undefined;
      version = (data?.version as Record<string, string>)?.string ?? '';
      const caps = data?.capabilities as Record<string, unknown> | undefined;
      const checksums = caps?.checksums as Record<string, unknown> | undefined;
      hasChecksums = Array.isArray(checksums?.supportedTypes) && (checksums.supportedTypes as string[]).length > 0;
    }

    // Get current sync-token
    const syncToken = await this.getSyncToken();

    this.features = {
      isNextcloud: true,
      version,
      hasChecksums,
      hasFilesLocking: false,
      syncToken,
    };
    return this.features;
  }

  async getFiles(path: string): Promise<RemoteFileInfo[]> {
    const res = await requestUrl({
      url: this.remoteUrl(path),
      method: 'PROPFIND',
      headers: {
        Authorization: this.authHeader,
        Depth: 'infinity',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
      throw: false,
    });
    // ベースフォルダ未作成（初回同期前）は 404。空リスト扱いにして初回アップロードへ進む。
    if (res.status === 404) return [];
    if (res.status !== 207) throw new NetworkError(res.status, res.text);
    return this.parsePropfindResponse(res.text);
  }

  async getChanges(syncToken: string): Promise<SyncChanges> {
    // sync-collection REPORT はベースフォルダ（Vault フォルダ）に限定して実行する。
    const res = await requestUrl({
      url: this.remoteUrl(''),
      method: 'REPORT',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: REPORT_BODY(syncToken),
      throw: false,
    });
    if (res.status === 410) throw new SyncTokenExpiredError();
    if (res.status !== 207) throw new NetworkError(res.status, res.text);
    return this.parseSyncChanges(res.text);
  }

  async downloadFile(remotePath: string, localTmpPath: string): Promise<void> {
    const res = await requestUrl({ url: this.remoteUrl(remotePath), method: 'GET', headers: { Authorization: this.authHeader }, throw: false });
    if (res.status !== 200) throw new NetworkError(res.status, '');
    // The actual write to localTmpPath is handled by SyncEngine via LocalAdapter
    // Store buffer reference for retrieval
    (this as Record<string, unknown>)._lastDownload = res.arrayBuffer;
    void localTmpPath; // used by SyncEngine after this call
  }

  /** Returns the last downloaded ArrayBuffer (called by SyncEngine after downloadFile). */
  getLastDownloadBuffer(): ArrayBuffer {
    return (this as Record<string, unknown>)._lastDownload as ArrayBuffer ?? new ArrayBuffer(0);
  }

  async uploadFile(remotePath: string, data: ArrayBuffer): Promise<void> {
    // PUT は親ディレクトリを自動生成しないため、先にベースフォルダ含む親階層を作成する。
    await ensureRemoteDir({ baseUrl: this.baseUrl, authHeader: this.authHeader }, toRemotePath(this.remoteBase, remotePath), this.createdDirs);
    const res = await requestUrl({
      url: this.remoteUrl(remotePath),
      method: 'PUT',
      headers: { Authorization: this.authHeader },
      body: data,
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async moveFile(oldPath: string, newPath: string): Promise<void> {
    // 移動先の親ディレクトリを確保してから MOVE する。
    await ensureRemoteDir({ baseUrl: this.baseUrl, authHeader: this.authHeader }, toRemotePath(this.remoteBase, newPath), this.createdDirs);
    const res = await requestUrl({
      url: this.remoteUrl(oldPath),
      method: 'MOVE',
      headers: { Authorization: this.authHeader, Destination: this.remoteUrl(newPath), Overwrite: 'F' },
      throw: false,
    });
    if (res.status === 412) throw new ConflictError(newPath);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async deleteFile(path: string, _expectedRemoteId: string): Promise<void> {
    const res = await requestUrl({
      url: this.remoteUrl(path), method: 'DELETE', headers: { Authorization: this.authHeader }, throw: false,
    });
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async getSyncToken(): Promise<string | null> {
    // sync-token は REPORT と同じコレクション（ベースフォルダ）から取得する。
    const res = await requestUrl({
      url: this.remoteUrl(''),
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:sync-token/></d:prop></d:propfind>`,
      throw: false,
    });
    if (res.status !== 207) return null;
    const match = res.text.match(/<d:sync-token>([^<]+)<\/d:sync-token>/);
    return match ? match[1] : null;
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
      const isCollection = resourcetype?.getElementsByTagNameNS('DAV:', 'collection').length > 0;
      if (isCollection) continue;

      const etag = prop.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent?.replace(/"/g, '') ?? null;
      const size = parseInt(prop.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent ?? '0', 10);
      const lastModifiedStr = prop.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent ?? '';
      const lastModified = lastModifiedStr ? new Date(lastModifiedStr).getTime() : 0;
      const checksumRaw = prop.getElementsByTagNameNS('http://owncloud.org/ns', 'checksums')[0]?.textContent ?? null;
      const fileId = prop.getElementsByTagNameNS('http://owncloud.org/ns', 'fileid')[0]?.textContent ?? null;

      // Extract SHA256 from checksums like "SHA256:abc123 MD5:def456"
      let checksum: string | null = null;
      if (checksumRaw) {
        const m = checksumRaw.match(/SHA256:([0-9a-fA-F]+)/i);
        checksum = m ? m[1].toLowerCase() : null;
      }

      const fullPath = decodeURIComponent(href.replace(/^.*\/remote\.php\/dav\/files\/[^/]+\//, ''));
      const path = fromRemotePath(this.remoteBase, fullPath);
      if (path === null || path === '') continue; // ベースフォルダ外、またはフォルダ自身はスキップ
      results.push({ path, fileId, checksum, etag, size, lastModified });
    }
    return results;
  }

  private parseSyncChanges(xml: string): SyncChanges {
    const modified: RemoteFileInfo[] = [];
    const deleted: string[] = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    const newSyncTokenEl = doc.getElementsByTagNameNS('DAV:', 'sync-token')[0];
    const newSyncToken = newSyncTokenEl?.textContent ?? '';

    for (let i = 0; i < responses.length; i++) {
      const resp = responses[i];
      const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
      const fullPath = decodeURIComponent(href.replace(/^.*\/remote\.php\/dav\/files\/[^/]+\//, ''));
      const path = fromRemotePath(this.remoteBase, fullPath);
      if (path === null || path === '') continue; // ベースフォルダ外、またはフォルダ自身はスキップ
      const statusEl = resp.getElementsByTagNameNS('DAV:', 'status')[0];
      if (statusEl?.textContent?.includes('404')) {
        deleted.push(path);
        continue;
      }
      const prop = resp.getElementsByTagNameNS('DAV:', 'prop')[0];
      if (!prop) continue;
      const etag = prop.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent?.replace(/"/g, '') ?? null;
      const size = parseInt(prop.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent ?? '0', 10);
      const lastModifiedStr = prop.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent ?? '';
      const lastModified = lastModifiedStr ? new Date(lastModifiedStr).getTime() : 0;
      const checksumRaw = prop.getElementsByTagNameNS('http://owncloud.org/ns', 'checksums')[0]?.textContent ?? null;
      const fileId = prop.getElementsByTagNameNS('http://owncloud.org/ns', 'fileid')[0]?.textContent ?? null;
      let checksum: string | null = null;
      if (checksumRaw) {
        const m = checksumRaw.match(/SHA256:([0-9a-fA-F]+)/i);
        checksum = m ? m[1].toLowerCase() : null;
      }
      modified.push({ path, fileId, checksum, etag, size, lastModified });
    }
    return { modified, deleted, newSyncToken };
  }
}
