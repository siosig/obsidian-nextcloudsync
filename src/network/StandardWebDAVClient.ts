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

export class StandardWebDAVClient implements IWebDAVClient {
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
    // Depth:infinity を許可しない標準 WebDAV サーバーが多いため、Depth:1 を再帰して全階層を走査する。
    const results: RemoteFileInfo[] = [];
    await this.propfindRecursive(path, results, new Set());
    return results;
  }

  /** 1 つのコレクションを Depth:1 で取得し、ファイルを収集しつつサブコレクションを再帰する。 */
  private async propfindRecursive(rel: string, out: RemoteFileInfo[], visited: Set<string>): Promise<void> {
    if (visited.has(rel)) return; // 自己参照・循環ガード
    visited.add(rel);
    const res = await requestUrl({
      url: this.remoteUrl(rel),
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`,
      throw: false,
    });
    // フォルダ未作成（初回同期前など）は 404。空として扱う。
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

  /**
   * Depth:1 の PROPFIND 応答を解析し、ファイルとサブフォルダ（いずれも Vault 相対パス）に分類する。
   * 要求対象のコレクション自身・ベースフォルダ外のエントリは除外する。
   * @param requestRel この PROPFIND を発行した Vault 相対パス（自己エントリ除外に使用）
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
      if (rel === null || rel === '' || rel === requestRel) continue; // ベース外・コレクション自身はスキップ
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

  /**
   * PROPFIND 応答の href を Vault 相対パスへ変換する。
   * href（絶対 URL または絶対パス）から serverUrl のパス部分を除いて files ルート相対を求め、
   * さらにベースフォルダ（Vault 名）を除去する。ベース外なら null。
   */
  private hrefToRel(href: string): string | null {
    let pathname: string;
    try {
      pathname = new URL(href, this.baseUrl).pathname;
    } catch {
      pathname = href;
    }
    pathname = decodeURIComponent(pathname);
    const basePath = decodeURIComponent(new URL(this.baseUrl).pathname).replace(/\/+$/, '');
    let fromRoot = basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
    fromRoot = fromRoot.replace(/^\/+|\/+$/g, '');
    return fromRemotePath(this.remoteBase, fromRoot);
  }
}
