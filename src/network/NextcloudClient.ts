import { requestUrl } from 'obsidian';
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
  FileLockedError,
  MaintenanceModeError,
  PreconditionFailedError,
} from '../types';
import { IWebDAVClient } from './IWebDAVClient';
import { DavSyncSettings } from '../types';
import { toRemotePath, hrefToRelative, encodeRemoteUrl, ensureRemoteDir } from './remotePath';
import { sha256 } from '../util/hash';
import { PARSE_YIELD_EVERY } from '../util/limits';
import { NO_CACHE_HEADERS } from './noCacheHeaders';

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
  /** Remote directories already created via MKCOL (in-session cache). */
  private readonly createdDirs = new Set<string>();
  /**
   * Set once a sync-collection REPORT returns 415: Nextcloud's files DAV does not implement
   * the RFC 6578 sync-collection REPORT (it raises Sabre ReportNotSupported). After the first
   * detection we skip the REPORT for the rest of this client's life and rely on full-scan, so
   * we don't pay a 415 round-trip on every sync.
   */
  private syncCollectionUnsupported = false;

  constructor(
    private readonly settings: DavSyncSettings,
    private readonly appPassword: string,
    /** Base folder for the remote sync target (usually the Vault name). Empty string means directly under the files root. */
    private readonly remoteBase: string = '',
    /** Optional diagnostic sink (wired to the Debug-mode file log) for network-level troubleshooting. */
    private readonly diag?: (msg: string) => void,
  ) {}

  private get baseUrl(): string {
    return this.settings.serverUrl.replace(/\/$/, '');
  }

  /** The server's base URL, derived by stripping `/remote.php/...` and everything after it from the WebDAV endpoint URL. */
  private serverBaseUrl(): string {
    return this.settings.serverUrl.replace(/\/remote\.php.*$/, '').replace(/\/$/, '');
  }

  /** Returns the base URL for non-files DAV namespaces such as versions / uploads. */
  private davBase(namespace: 'versions' | 'uploads'): string {
    return `${this.serverBaseUrl()}/remote.php/dav/${namespace}/${encodeURIComponent(this.settings.username)}`;
  }

  /** Converts a Vault-relative path into a WebDAV URL under the base folder. */
  private remoteUrl(rel: string): string {
    return encodeRemoteUrl(this.baseUrl, toRemotePath(this.remoteBase, rel));
  }

  /**
   * Drop every ancestor directory of `remoteFilePath` from the in-session "already created" cache
   * (spec 024). Call this when a write proves the parent is actually missing (PUT/MKCOL 404/409) so
   * {@link ensureRemoteDir} re-issues the MKCOLs instead of trusting a stale positive cache entry —
   * which happens when another device deletes a folder this client previously created.
   */
  private forgetCreatedAncestors(remoteFilePath: string): void {
    const segments = remoteFilePath.split('/').slice(0, -1); // drop the trailing file name
    let acc = '';
    for (const seg of segments) {
      if (!seg) continue;
      acc = acc ? `${acc}/${seg}` : seg;
      this.createdDirs.delete(acc);
    }
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
    const statusRes = await requestUrl({ url: statusUrl, method: 'GET', headers: { ...NO_CACHE_HEADERS }, throw: false });
    if (statusRes.status === 200) {
      const status = statusRes.json as Record<string, unknown>;
      if (status.maintenance === true) {
        throw new MaintenanceModeError();
      }
    }

    // Get capabilities
    const capUrl = this.settings.serverUrl.replace(/\/remote\.php.*$/, '') + '/ocs/v1.php/cloud/capabilities?format=json';
    const capRes = await requestUrl({
      url: capUrl,
      method: 'GET',
      headers: { Authorization: this.authHeader, 'OCS-APIRequest': 'true', ...NO_CACHE_HEADERS },
      throw: false,
    });

    let version = '';
    let hasChecksums = false;
    let hasFilesLocking = false;
    let hasBulkUpload = false;

    if (capRes.status === 200) {
      const cap = capRes.json as Record<string, unknown>;
      const data = (cap as Record<string, Record<string, unknown>>).ocs?.data as Record<string, unknown> | undefined;
      version = (data?.version as Record<string, string>)?.string ?? '';
      const caps = data?.capabilities as Record<string, unknown> | undefined;
      const checksums = caps?.checksums as Record<string, unknown> | undefined;
      hasChecksums = Array.isArray(checksums?.supportedTypes) && (checksums.supportedTypes as string[]).length > 0;
      // When the files_lock app is enabled, capabilities.files.locking contains a version string.
      const files = caps?.files as Record<string, unknown> | undefined;
      hasFilesLocking = files?.locking != null && files.locking !== false;
      // The bulk-upload endpoint is advertised under capabilities.dav.bulkupload (a version string)
      // on servers that support it. Absent ⇒ fall back to per-file PUT (feature-gated by the engine).
      const dav = caps?.dav as Record<string, unknown> | undefined;
      hasBulkUpload = dav?.bulkupload != null && dav.bulkupload !== false;
    }

    // Get current sync-token
    const syncToken = await this.getSyncToken();

    this.features = {
      isNextcloud: true,
      version,
      hasChecksums,
      hasFilesLocking,
      hasBulkUpload,
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
        ...NO_CACHE_HEADERS,
      },
      body: PROPFIND_BODY,
      throw: false,
    });
    // A missing base folder (before the first sync) returns 404. Treat it as an empty list and proceed to the initial upload.
    if (res.status === 404) return [];
    if (res.status !== 207) throw new NetworkError(res.status, res.text);
    return await this.parsePropfindResponse(res.text);
  }

  async getRootEtag(): Promise<string | null> {
    // Root-ETag short-circuit (spec 023): a single Depth:0 PROPFIND on the vault root. Nextcloud
    // propagates any descendant change up to the root collection's ETag, so a matching value means
    // the remote tree is unchanged since the last full scan. Never throws — any non-207 (incl. 404
    // before the folder exists) or error yields null so the caller falls back to a real full scan.
    try {
      const res = await requestUrl({
        url: this.remoteUrl(''),
        method: 'PROPFIND',
        headers: { Authorization: this.authHeader, Depth: '0', 'Content-Type': 'application/xml; charset=utf-8', ...NO_CACHE_HEADERS },
        body: PROPFIND_BODY,
        throw: false,
      });
      if (res.status !== 207) return null;
      const doc = new DOMParser().parseFromString(res.text, 'text/xml');
      const resp = doc.getElementsByTagNameNS('DAV:', 'response')[0];
      const etag = resp?.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent?.replace(/"/g, '') ?? null;
      return etag && etag.length > 0 ? etag : null;
    } catch {
      return null;
    }
  }

  async getDirectories(path: string): Promise<RemoteDirInfo[]> {
    const res = await requestUrl({
      url: this.remoteUrl(path),
      method: 'PROPFIND',
      headers: {
        Authorization: this.authHeader,
        Depth: 'infinity',
        'Content-Type': 'application/xml; charset=utf-8',
        ...NO_CACHE_HEADERS,
      },
      body: PROPFIND_BODY,
      throw: false,
    });
    if (res.status === 404) return [];
    if (res.status !== 207) throw new NetworkError(res.status, res.text);
    return await this.parsePropfindDirectories(res.text);
  }

  async isRemoteDirEmpty(path: string): Promise<boolean> {
    // Depth:1 lists the collection itself plus its immediate children. "Empty" (rmdir
    // semantics) ⇔ the only response is the collection itself. Conservative on any
    // ambiguity: never report "empty" unless the server clearly says so, so a recursive
    // DELETE is never issued against a directory that might still hold data.
    const res = await requestUrl({
      url: this.remoteUrl(path),
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', ...NO_CACHE_HEADERS },
      body: PROPFIND_BODY,
      throw: false,
    });
    if (res.status !== 207) return false;
    const doc = new DOMParser().parseFromString(res.text, 'text/xml');
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    let children = 0;
    for (let i = 0; i < responses.length; i++) {
      const href = responses[i].getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
      const rel = hrefToRelative(this.baseUrl, this.remoteBase, href);
      // rel === '' is the collection itself (or the base); any other entry is a child.
      if (rel !== null && rel !== '' && rel !== path) children++;
    }
    return children === 0;
  }

  async createDirectory(path: string): Promise<void> {
    // ensureRemoteDir MKCOLs every segment of the path it is given EXCEPT the last (it assumes a
    // trailing file name), so append a dummy segment to have `path` itself (and its ancestors) created.
    await ensureRemoteDir(
      { baseUrl: this.baseUrl, authHeader: this.authHeader },
      toRemotePath(this.remoteBase, `${path}/_`),
      this.createdDirs,
    );
  }

  async deleteCollection(path: string): Promise<void> {
    const res = await requestUrl({
      url: this.remoteUrl(path), method: 'DELETE', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false,
    });
    if (res.status === 404) return; // already gone — the desired end state.
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async getChanges(syncToken: string): Promise<SyncChanges> {
    // Run the sync-collection REPORT scoped to the base folder (the Vault folder) only.
    const res = await requestUrl({
      url: this.remoteUrl(''),
      method: 'REPORT',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/xml; charset=utf-8',
        ...NO_CACHE_HEADERS,
      },
      body: REPORT_BODY(syncToken),
      throw: false,
    });
    if (res.status === 410) throw new SyncTokenExpiredError();
    if (res.status !== 207) throw new NetworkError(res.status, res.text);
    return await this.parseSyncChanges(res.text);
  }

  async downloadFile(remotePath: string): Promise<ArrayBuffer> {
    const res = await requestUrl({ url: this.remoteUrl(remotePath), method: 'GET', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false });
    if (res.status !== 200) throw new NetworkError(res.status, '');
    // Return the bytes directly (no shared field) so concurrent downloads cannot race each other.
    return res.arrayBuffer;
  }

  async uploadFile(
    remotePath: string, data: ArrayBuffer, mtime?: number,
    opts?: { precomputedSha256?: string; ifMatchEtag?: string | null },
  ): Promise<void> {
    // Reactive directory creation (P1-B): try the PUT first and only MKCOL the parents if the server
    // reports a missing parent (409), then retry once. This drops the per-upload directory probe on
    // the common path (the directory almost always already exists).
    const checksum = `SHA256:${opts?.precomputedSha256 ?? await sha256(data)}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      'OC-Checksum': checksum,
      ...NO_CACHE_HEADERS,
    };
    // X-OC-MTime (Unix seconds) tells Nextcloud to preserve the local file's modification time.
    if (mtime) headers['X-OC-MTime'] = String(Math.floor(mtime / 1000));
    // If-Match optimistic concurrency: a remote changed since this etag returns 412.
    if (opts?.ifMatchEtag) headers['If-Match'] = `"${opts.ifMatchEtag.replace(/^"|"$/g, '')}"`;

    let res = await requestUrl({ url: this.remoteUrl(remotePath), method: 'PUT', headers, body: data, throw: false });
    // Missing parent collection → create ancestors, then retry the PUT once. Standard WebDAV
    // returns 409, but Nextcloud's files DAV returns 404 for a missing parent — handle both
    // so the first upload into a not-yet-created folder (e.g. a fresh device) succeeds.
    if (res.status === 409 || res.status === 404) {
      // The parent is provably missing now, so any "already created" entry for it in our in-session
      // cache is STALE (e.g. another device deleted the folder after we created it). Drop the ancestor
      // entries so ensureRemoteDir actually re-issues the MKCOLs — otherwise a stale positive cache
      // entry makes the retry PUT 404 forever and the local change never reaches the remote (spec 024).
      this.forgetCreatedAncestors(toRemotePath(this.remoteBase, remotePath));
      await ensureRemoteDir({ baseUrl: this.baseUrl, authHeader: this.authHeader }, toRemotePath(this.remoteBase, remotePath), this.createdDirs);
      res = await requestUrl({ url: this.remoteUrl(remotePath), method: 'PUT', headers, body: data, throw: false });
    }
    if (res.status === 412) throw new PreconditionFailedError(remotePath); // remote changed (If-Match)
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async recalcChecksum(remotePath: string): Promise<string | null> {
    // Nextcloud's ChecksumUpdatePlugin computes the hash server-side for an existing file
    // (no download) and persists it, returning it in the OC-Checksum response header.
    const res = await requestUrl({
      url: this.remoteUrl(remotePath),
      method: 'PATCH',
      headers: { Authorization: this.authHeader, 'X-Recalculate-Hash': 'sha256', ...NO_CACHE_HEADERS },
      throw: false,
    });
    if (res.status !== 204 && res.status !== 200) return null;
    const header = res.headers['oc-checksum'] ?? res.headers['OC-Checksum'] ?? '';
    const m = header.match(/SHA256:([0-9a-fA-F]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  async moveFile(oldPath: string, newPath: string): Promise<void> {
    // Ensure the destination's parent directory exists before MOVE.
    await ensureRemoteDir({ baseUrl: this.baseUrl, authHeader: this.authHeader }, toRemotePath(this.remoteBase, newPath), this.createdDirs);
    const res = await requestUrl({
      url: this.remoteUrl(oldPath),
      method: 'MOVE',
      headers: { Authorization: this.authHeader, Destination: this.remoteUrl(newPath), Overwrite: 'F', ...NO_CACHE_HEADERS },
      throw: false,
    });
    if (res.status === 412) throw new ConflictError(newPath);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async deleteFile(path: string, _expectedRemoteId: string): Promise<void> {
    const res = await requestUrl({
      url: this.remoteUrl(path), method: 'DELETE', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false,
    });
    // Blind delete (P1-B): a 404 means the file is already gone — exactly the desired end state, so
    // treat it as success rather than an error (no pre-deletion existence probe is needed).
    if (res.status === 404) return;
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  async getSyncToken(): Promise<string | null> {
    // Nextcloud's files DAV does not implement the RFC 6578 sync-collection REPORT (it raises
    // Sabre ReportNotSupported → HTTP 415). Once we've seen that, skip the REPORT entirely and
    // let the engine full-scan, instead of paying a guaranteed-415 round-trip every sync.
    if (this.syncCollectionUnsupported) return null;
    // Bootstrap the token the RFC 6578 way (servers that DO support it): a sync-collection REPORT
    // with an EMPTY token ("initial sync") whose multistatus carries the current <d:sync-token>.
    const res = await requestUrl({
      url: this.remoteUrl(''),
      method: 'REPORT',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/xml; charset=utf-8', ...NO_CACHE_HEADERS },
      body: REPORT_BODY(''),
      throw: false,
    });
    // 415 = sync-collection REPORT unsupported (Nextcloud files DAV). Remember it and full-scan.
    if (res.status === 415) {
      this.syncCollectionUnsupported = true;
      this.diag?.('getSyncToken(REPORT): 415 sync-collection unsupported — full-scan for the rest of this session');
      return null;
    }
    // Match regardless of the XML namespace prefix; require a non-empty value (skip <…sync-token/>).
    const match = res.status === 207 ? res.text.match(/<(?:\w+:)?sync-token>([^<]+)<\/(?:\w+:)?sync-token>/) : null;
    const token = match ? match[1].trim() : '';
    if (token.length === 0) {
      // Diagnose: log the status and a short, sanitised body snippet so a captured debug log reveals
      // the actual server response if a token still cannot be obtained.
      const snippet = (res.text ?? '').replace(/\s+/g, ' ').slice(0, 400);
      this.diag?.(`getSyncToken(REPORT): NO TOKEN (status=${res.status}) body[0:400]=${snippet}`);
      return null;
    }
    return token;
  }

  async remoteExists(remotePath: string): Promise<boolean> {
    // Targeted existence probe (PROPFIND Depth 0). Only a definitive 404 means "gone"; any other
    // status (incl. transient errors) is treated as "present" so callers never delete on ambiguity.
    try {
      const res = await requestUrl({
        url: this.remoteUrl(remotePath),
        method: 'PROPFIND',
        headers: { Authorization: this.authHeader, Depth: '0', ...NO_CACHE_HEADERS },
        throw: false,
      });
      return res.status !== 404;
    } catch {
      return true; // conservative: never report "gone" on a failed check
    }
  }

  // ── US2: Version history ────────────────────────────────────────────────────

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
        ...NO_CACHE_HEADERS,
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
      headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS },
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
      headers: { Authorization: this.authHeader, Destination: destination, ...NO_CACHE_HEADERS },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
  }

  /** Builds the URL used for GET/MOVE on a version. */
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
      // Skip a trailing slash (the collection itself).
      if (href.endsWith('/')) continue;
      const segments = decodeURIComponent(href).split('/').filter(Boolean);
      const versionId = segments[segments.length - 1] ?? '';
      // Exclude the collection itself (the fileId folder) and restore.
      if (!versionId || versionId === fileId) continue;
      const prop = resp.getElementsByTagNameNS('DAV:', 'prop')[0];
      const lastModifiedStr = prop?.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent ?? '';
      const lastModified = lastModifiedStr ? new Date(lastModifiedStr).getTime() : 0;
      const size = parseInt(prop?.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent ?? '0', 10);
      versions.push({ versionId, href, lastModified, size });
    }
    // Newest first (descending by lastModified).
    versions.sort((a, b) => b.lastModified - a.lastModified);
    return versions;
  }

  // ── US3: Chunked upload ──────────────────────────────────────────────

  async uploadChunked(remotePath: string, data: ArrayBuffer, chunkSizeBytes: number): Promise<void> {
    const uploadId = `obsidian-${this.settings.deviceId.slice(-8)}-${Date.now()}`;
    const sessionUrl = `${this.davBase('uploads')}/${uploadId}`;
    const finalUrl = this.remoteUrl(remotePath);
    const total = data.byteLength;

    // Compute the SHA-256 once here; reuse it for both the OC-Checksum header and
    // post-assembly verification so the full buffer is never hashed more than once.
    const sum = await sha256(data);

    try {
      // 1. Create the upload session.
      const mk = await requestUrl({ url: sessionUrl, method: 'MKCOL', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false });
      if (mk.status < 200 || mk.status >= 300) throw new NetworkError(mk.status, mk.text);

      // 2. PUT each chunk named by its start byte offset (15-digit zero-padded) so lexical order = assembly order.
      for (let offset = 0; offset < total; offset += chunkSizeBytes) {
        const end = Math.min(offset + chunkSizeBytes, total);
        const chunk = data.slice(offset, end);
        const chunkName = String(offset).padStart(15, '0');
        const put = await requestUrl({
          url: `${sessionUrl}/${chunkName}`,
          method: 'PUT',
          headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS },
          body: chunk,
          throw: false,
        });
        if (put.status < 200 || put.status >= 300) throw new NetworkError(put.status, put.text);
      }

      // 3. Ensure the parent directory of the final file exists, then assemble by MOVE-ing .file.
      // Drop any stale "already created" cache entries first so a folder another device deleted is
      // genuinely re-created (spec 024) — otherwise the assembling MOVE would target a missing parent.
      this.forgetCreatedAncestors(toRemotePath(this.remoteBase, remotePath));
      await ensureRemoteDir({ baseUrl: this.baseUrl, authHeader: this.authHeader }, toRemotePath(this.remoteBase, remotePath), this.createdDirs);
      const move = await requestUrl({
        url: `${sessionUrl}/.file`,
        method: 'MOVE',
        headers: {
          Authorization: this.authHeader,
          Destination: finalUrl,
          'OC-Total-Length': String(total),
          // Persist the SHA-256 on the assembled file (same rationale as uploadFile).
          'OC-Checksum': `SHA256:${sum}`,
          ...NO_CACHE_HEADERS,
        },
        throw: false,
      });
      if (move.status < 200 || move.status >= 300) throw new NetworkError(move.status, move.text);

      // 4. Verify the checksum after assembly (FR-012). Pass the precomputed hash to avoid
      //    hashing the full buffer a second time.
      await this.verifyRemoteChecksum(remotePath, data, sum);
    } catch (err) {
      // On abort, discard the session so no incomplete file is left at the final path (FR-011).
      await requestUrl({ url: sessionUrl, method: 'DELETE', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false }).catch(() => undefined);
      throw err;
    }
  }

  /** After upload, fetches the remote checksum and compares it with the local SHA-256.
   *  Skips verification if unavailable. Accepts an optional precomputed hash to avoid
   *  redundant hashing of the same buffer (used by uploadChunked). */
  private async verifyRemoteChecksum(remotePath: string, data: ArrayBuffer, precomputed?: string): Promise<void> {
    const res = await requestUrl({
      url: this.remoteUrl(remotePath),
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '0', 'Content-Type': 'application/xml; charset=utf-8', ...NO_CACHE_HEADERS },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:checksums/></d:prop></d:propfind>`,
      throw: false,
    });
    if (res.status !== 207) return;
    const m = res.text.match(/SHA256:([0-9a-fA-F]+)/i);
    if (!m) return;
    const remoteHash = m[1].toLowerCase();
    const localHash = precomputed ?? await sha256(data);
    if (remoteHash !== localHash) {
      throw new NetworkError(0, `Checksum mismatch after chunked upload: ${remotePath}`);
    }
  }

  // ── US4: Files Locking ─────────────────────────────────────────────────────

  async lockFile(remotePath: string): Promise<string> {
    const res = await requestUrl({
      url: this.remoteUrl(remotePath),
      method: 'LOCK',
      headers: { Authorization: this.authHeader, 'X-User-Lock': '1', ...NO_CACHE_HEADERS },
      throw: false,
    });
    if (res.status === 423) throw new FileLockedError(remotePath);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text);
    // Nextcloud's files_lock app returns the token in the XML body (<nc:lock-token>files_lock/…),
    // NOT in a Lock-Token response header. Parse the body first; fall back to headers for
    // RFC-4918 servers that do use the header. Without this the token is '' and UNLOCK cannot
    // release the lock (it would leak until the next sync's recovery).
    let token = '';
    try {
      const doc = new DOMParser().parseFromString(res.text, 'text/xml');
      token = doc.getElementsByTagNameNS('http://nextcloud.org/ns', 'lock-token')[0]?.textContent?.trim() ?? '';
    } catch {
      token = '';
    }
    if (!token) token = res.headers['lock-token'] ?? res.headers['oc-lock-token'] ?? '';
    return token;
  }

  async unlockFile(remotePath: string, token: string): Promise<void> {
    try {
      await requestUrl({
        url: this.remoteUrl(remotePath),
        method: 'UNLOCK',
        headers: { Authorization: this.authHeader, 'Lock-Token': token, 'X-User-Lock': '1', ...NO_CACHE_HEADERS },
        throw: false,
      });
    } catch {
      // Best-effort. A leftover lock is recovered on the next sync (FR-016).
    }
  }

  private async parsePropfindResponse(xml: string): Promise<RemoteFileInfo[]> {
    const results: RemoteFileInfo[] = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    for (let i = 0; i < responses.length; i++) {
      // Yield to the event loop periodically so parsing a large Depth:infinity listing does not
      // freeze the UI / trigger an Android ANR (FR-027 / P2-B).
      if (i > 0 && i % PARSE_YIELD_EVERY === 0) await new Promise((r) => window.setTimeout(r, 0));
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

      const path = hrefToRelative(this.baseUrl, this.remoteBase, href);
      if (path === null || path === '') continue; // Skip entries outside the base folder or the folder itself
      results.push({ path, fileId, checksum, etag, size, lastModified });
    }
    return results;
  }

  private async parsePropfindDirectories(xml: string): Promise<RemoteDirInfo[]> {
    const results: RemoteDirInfo[] = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    for (let i = 0; i < responses.length; i++) {
      if (i > 0 && i % PARSE_YIELD_EVERY === 0) await new Promise((r) => window.setTimeout(r, 0));
      const resp = responses[i];
      const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
      const prop = resp.getElementsByTagNameNS('DAV:', 'prop')[0];
      if (!prop) continue;
      const resourcetype = prop.getElementsByTagNameNS('DAV:', 'resourcetype')[0];
      const isCollection = resourcetype?.getElementsByTagNameNS('DAV:', 'collection').length > 0;
      if (!isCollection) continue; // mirror of parsePropfindResponse: here we KEEP only collections.

      const etag = prop.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent?.replace(/"/g, '') ?? null;
      const lastModifiedStr = prop.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent ?? '';
      const lastModified = lastModifiedStr ? new Date(lastModifiedStr).getTime() : 0;
      const fileId = prop.getElementsByTagNameNS('http://owncloud.org/ns', 'fileid')[0]?.textContent ?? null;

      const path = hrefToRelative(this.baseUrl, this.remoteBase, href);
      if (path === null || path === '') continue; // outside the base folder, or the base folder itself
      results.push({ path, fileId, etag, lastModified });
    }
    return results;
  }

  private async parseSyncChanges(xml: string): Promise<SyncChanges> {
    const modified: RemoteFileInfo[] = [];
    const deleted: string[] = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    const newSyncTokenEl = doc.getElementsByTagNameNS('DAV:', 'sync-token')[0];
    const newSyncToken = newSyncTokenEl?.textContent ?? '';

    for (let i = 0; i < responses.length; i++) {
      // Yield periodically (anti-ANR) — see parsePropfindResponse.
      if (i > 0 && i % PARSE_YIELD_EVERY === 0) await new Promise((r) => window.setTimeout(r, 0));
      const resp = responses[i];
      const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
      const path = hrefToRelative(this.baseUrl, this.remoteBase, href);
      if (path === null || path === '') continue; // Skip entries outside the base folder or the folder itself
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
