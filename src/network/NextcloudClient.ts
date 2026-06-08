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
  FileLockedError,
} from '../types';
import { IWebDAVClient } from './IWebDAVClient';
import { DavSyncSettings } from '../types';
import { toRemotePath, fromRemotePath, encodeRemoteUrl, ensureRemoteDir } from './remotePath';
import { sha256 } from '../util/hash';

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

  /** WebDAV エンドポイント URL から `/remote.php/...` 以降を除いたサーバーのベース URL。 */
  private serverBaseUrl(): string {
    return this.settings.serverUrl.replace(/\/remote\.php.*$/, '').replace(/\/$/, '');
  }

  /** versions / uploads など files 以外の DAV 名前空間のベース URL を返す。 */
  private davBase(namespace: 'versions' | 'uploads'): string {
    return `${this.serverBaseUrl()}/remote.php/dav/${namespace}/${encodeURIComponent(this.settings.username)}`;
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
    let hasFilesLocking = false;

    if (capRes.status === 200) {
      const cap = capRes.json as Record<string, unknown>;
      const data = (cap as Record<string, Record<string, unknown>>).ocs?.data as Record<string, unknown> | undefined;
      version = (data?.version as Record<string, string>)?.string ?? '';
      const caps = data?.capabilities as Record<string, unknown> | undefined;
      const checksums = caps?.checksums as Record<string, unknown> | undefined;
      hasChecksums = Array.isArray(checksums?.supportedTypes) && (checksums.supportedTypes as string[]).length > 0;
      // files_lock app が有効だと capabilities.files.locking にバージョン文字列が入る。
      const files = caps?.files as Record<string, unknown> | undefined;
      hasFilesLocking = files?.locking != null && files.locking !== false;
    }

    // Get current sync-token
    const syncToken = await this.getSyncToken();

    this.features = {
      isNextcloud: true,
      version,
      hasChecksums,
      hasFilesLocking,
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

  // ── US2: バージョン履歴 ────────────────────────────────────────────────────

  async listVersions(fileId: string): Promise<FileVersion[]> {
    if (!fileId) throw new FeatureUnsupportedError('versions');
    const collectionUrl = `${this.davBase('versions')}/versions/${encodeURIComponent(fileId)}`;
    const res = await requestUrl({
      url: collectionUrl,
      method: 'PROPFIND',
      headers: {
        Authorization: this.authHeader,
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>`,
      throw: false,
    });
    if (res.status === 404) return [];
    if (res.status !== 207) throw new NetworkError(res.status, res.text);
    return this.parseVersions(res.text, fileId);
  }

  async getVersionContent(version: FileVersion, fileId: string): Promise<ArrayBuffer> {
    if (!fileId) throw new FeatureUnsupportedError('versions');
    const res = await requestUrl({
      url: this.versionUrl(version, fileId),
      method: 'GET',
      headers: { Authorization: this.authHeader },
      throw: false,
    });
    if (res.status !== 200) throw new NetworkError(res.status, '');
    return res.arrayBuffer;
  }

  async restoreVersion(version: FileVersion, fileId: string): Promise<void> {
    if (!fileId) throw new FeatureUnsupportedError('versions');
    const destination = `${this.davBase('versions')}/restore/target`;
    const res = await requestUrl({
      url: this.versionUrl(version, fileId),
      method: 'MOVE',
      headers: { Authorization: this.authHeader, Destination: destination },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  /** バージョンの GET/MOVE 用 URL を組み立てる。 */
  private versionUrl(version: FileVersion, fileId: string): string {
    return `${this.davBase('versions')}/versions/${encodeURIComponent(fileId)}/${encodeURIComponent(version.versionId)}`;
  }

  private parseVersions(xml: string, fileId: string): FileVersion[] {
    const versions: FileVersion[] = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    for (let i = 0; i < responses.length; i++) {
      const resp = responses[i];
      const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
      // 末尾スラッシュ（コレクション自身）はスキップ。
      if (href.endsWith('/')) continue;
      const segments = decodeURIComponent(href).split('/').filter(Boolean);
      const versionId = segments[segments.length - 1] ?? '';
      // 自身（fileId フォルダ）や restore は対象外。
      if (!versionId || versionId === fileId) continue;
      const prop = resp.getElementsByTagNameNS('DAV:', 'prop')[0];
      const lastModifiedStr = prop?.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent ?? '';
      const lastModified = lastModifiedStr ? new Date(lastModifiedStr).getTime() : 0;
      const size = parseInt(prop?.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent ?? '0', 10);
      versions.push({ versionId, href, lastModified, size });
    }
    // 新しい順（lastModified 降順）。
    versions.sort((a, b) => b.lastModified - a.lastModified);
    return versions;
  }

  // ── US3: チャンクアップロード ──────────────────────────────────────────────

  async uploadChunked(remotePath: string, data: ArrayBuffer, chunkSizeBytes: number): Promise<void> {
    const uploadId = `obsidian-${this.settings.deviceId.slice(-8)}-${Date.now()}`;
    const sessionUrl = `${this.davBase('uploads')}/${uploadId}`;
    const finalUrl = this.remoteUrl(remotePath);
    const total = data.byteLength;

    try {
      // 1. アップロードセッション作成。
      const mk = await requestUrl({ url: sessionUrl, method: 'MKCOL', headers: { Authorization: this.authHeader }, throw: false });
      if (mk.status < 200 || mk.status >= 300) throw new NetworkError(mk.status, mk.text);

      // 2. 各チャンクを「15桁ゼロ埋めの開始バイトオフセット」名で PUT（辞書順 = 結合順）。
      for (let offset = 0; offset < total; offset += chunkSizeBytes) {
        const end = Math.min(offset + chunkSizeBytes, total);
        const chunk = data.slice(offset, end);
        const chunkName = String(offset).padStart(15, '0');
        const put = await requestUrl({
          url: `${sessionUrl}/${chunkName}`,
          method: 'PUT',
          headers: { Authorization: this.authHeader },
          body: chunk,
          throw: false,
        });
        if (put.status < 200 || put.status >= 300) throw new NetworkError(put.status, put.text);
      }

      // 3. 最終ファイルの親ディレクトリを確保してから .file を MOVE で結合。
      await ensureRemoteDir({ baseUrl: this.baseUrl, authHeader: this.authHeader }, toRemotePath(this.remoteBase, remotePath), this.createdDirs);
      const move = await requestUrl({
        url: `${sessionUrl}/.file`,
        method: 'MOVE',
        headers: {
          Authorization: this.authHeader,
          Destination: finalUrl,
          'OC-Total-Length': String(total),
        },
        throw: false,
      });
      if (move.status < 200 || move.status >= 300) throw new NetworkError(move.status, move.text);

      // 4. 結合後のチェックサム検証（FR-012）。取得できる場合のみ照合する。
      await this.verifyRemoteChecksum(remotePath, data);
    } catch (err) {
      // 中断時はセッションを破棄して最終パスに不完全ファイルを残さない（FR-011）。
      await requestUrl({ url: sessionUrl, method: 'DELETE', headers: { Authorization: this.authHeader }, throw: false }).catch(() => undefined);
      throw err;
    }
  }

  /** アップロード後にリモート checksum を取得しローカル SHA-256 と照合する。取得不可なら検証スキップ。 */
  private async verifyRemoteChecksum(remotePath: string, data: ArrayBuffer): Promise<void> {
    const res = await requestUrl({
      url: this.remoteUrl(remotePath),
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:checksums/></d:prop></d:propfind>`,
      throw: false,
    });
    if (res.status !== 207) return;
    const m = res.text.match(/SHA256:([0-9a-fA-F]+)/i);
    if (!m) return;
    const remoteHash = m[1].toLowerCase();
    const localHash = await sha256(data);
    if (remoteHash !== localHash) {
      throw new NetworkError(0, `Checksum mismatch after chunked upload: ${remotePath}`);
    }
  }

  // ── US4: Files Locking ─────────────────────────────────────────────────────

  async lockFile(remotePath: string): Promise<string> {
    const res = await requestUrl({
      url: this.remoteUrl(remotePath),
      method: 'LOCK',
      headers: { Authorization: this.authHeader, 'X-User-Lock': '1' },
      throw: false,
    });
    if (res.status === 423) throw new FileLockedError(remotePath);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
    const token = res.headers['lock-token'] ?? res.headers['oc-lock-token'] ?? '';
    return token;
  }

  async unlockFile(remotePath: string, token: string): Promise<void> {
    try {
      await requestUrl({
        url: this.remoteUrl(remotePath),
        method: 'UNLOCK',
        headers: { Authorization: this.authHeader, 'Lock-Token': token, 'X-User-Lock': '1' },
        throw: false,
      });
    } catch {
      // ベストエフォート。残留ロックは次回同期で回復する（FR-016）。
    }
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
