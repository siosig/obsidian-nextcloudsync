import { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { requestUrlWithTimeout } from './requestWithTimeout';
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
  RemoteRootMissingError,
  RemoteDirCreateError,
  VaultRootOutcome,
  ServerLockedError,
} from '../types';
import { IWebDAVClient } from './IWebDAVClient';
import { DavSyncSettings } from '../types';
import { toRemotePath, hrefToRelative, encodeRemoteUrl, encodeServerUrl, ensureRemoteDir, mkcolStrict, prepareMissingParentRetry, isTransportFailure } from './remotePath';
import { RemoteDirCache } from './RemoteDirCache';
import { sha256 } from '../util/hash';
import { PARSE_YIELD_EVERY } from '../util/limits';
import { NO_CACHE_HEADERS } from './noCacheHeaders';
import {
  readMultistatus, readSyncToken, readHref, readProp, readStatusText,
  readIsCollection, readDavProps, readOwncloudProps, readLockDiscoveryOwner,
} from './dav/propfind';
import { withRetry } from '../util/retry';

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

// Depth:0 PROPFIND for D:lockdiscovery only, sent once after a 423.
const LOCKDISCOVERY_BODY = `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>`;

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
  private readonly createdDirs = new RemoteDirCache();

  constructor(
    private readonly settings: DavSyncSettings,
    private readonly appPassword: string,
    // Remote base folder (usually the Vault name); '' = directly under the files root.
    private readonly remoteBase: string = '',
    private readonly diag?: (msg: string) => void,
  ) {}

  private get baseUrl(): string {
    // encodeServerUrl: the configured Server URL may end in a subfolder containing a space or
    // non-ASCII characters, and it is the base of every request URL (see remotePath.ts).
    return encodeServerUrl(this.settings.serverUrl.replace(/\/$/, ''));
  }

  // Derived by stripping /remote.php/... and everything after it from the WebDAV endpoint URL.
  private serverBaseUrl(): string {
    return encodeServerUrl(this.settings.serverUrl.replace(/\/remote\.php.*$/, '').replace(/\/$/, ''));
  }

  // Base URL for non-files DAV namespaces (versions, uploads).
  private davBase(namespace: 'versions' | 'uploads'): string {
    return `${this.serverBaseUrl()}/remote.php/dav/${namespace}/${encodeURIComponent(this.settings.username)}`;
  }

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

  // ms; 0 = unbounded. Read live so a settings change applies on the next request.
  private get timeoutMs(): number {
    return (this.settings.networkTimeoutSeconds ?? 0) * 1000;
  }

  private req(params: RequestUrlParam): Promise<RequestUrlResponse> {
    return requestUrlWithTimeout(params, this.timeoutMs);
  }

  // Read-only requests (PROPFIND/GET) retry up to 2x: req() rejects only when no HTTP response arrived, so every rejection here is
  // transient. Logs one debug line per retry. Writes and the REPORT-based sync-token/getChanges calls stay on plain req() (docs/spec.md §5.6a).
  private reqReadonly(params: RequestUrlParam): Promise<RequestUrlResponse> {
    return withRetry(() => this.req(params), 2, 1000, (err) => {
      this.diag?.(`reqReadonly retry: ${params.method ?? 'GET'} ${params.url} (${err instanceof Error ? err.message : String(err)})`);
      return true;
    });
  }

  async connect(): Promise<NextcloudFeatures> {
    const statusUrl = this.settings.serverUrl.replace(/\/remote\.php.*$/, '') + '/status.php';
    const statusRes = await this.reqReadonly({ url: statusUrl, method: 'GET', headers: { ...NO_CACHE_HEADERS }, throw: false });
    // productname (from /status.php, already parsed here and needing no authentication) is the second detection witness,
    // useful when a genuine Nextcloud has its OCS endpoint closed off.
    let statusProductName = '';
    if (statusRes.status === 200) {
      const status = statusRes.json as Record<string, unknown>;
      if (status.maintenance === true) {
        throw new MaintenanceModeError();
      }
      statusProductName = typeof status.productname === 'string' ? status.productname : '';
    }

    const capUrl = this.settings.serverUrl.replace(/\/remote\.php.*$/, '') + '/ocs/v1.php/cloud/capabilities?format=json';
    const capRes = await this.reqReadonly({
      url: capUrl,
      method: 'GET',
      headers: { Authorization: this.authHeader, 'OCS-APIRequest': 'true', ...NO_CACHE_HEADERS },
      throw: false,
    });

    let version = '';
    let hasChecksums = false;
    let hasFilesLocking = false;
    let hasBulkUpload = false;
    // Whether OCS actually yielded capabilities: the primary detection witness.
    let ocsAnswered = false;

    if (capRes.status === 200) {
      const cap = capRes.json as Record<string, unknown>;
      const data = (cap as Record<string, Record<string, unknown>>).ocs?.data as Record<string, unknown> | undefined;
      ocsAnswered = data != null;
      version = (data?.version as Record<string, string>)?.string ?? '';
      const caps = data?.capabilities as Record<string, unknown> | undefined;
      const checksums = caps?.checksums as Record<string, unknown> | undefined;
      hasChecksums = Array.isArray(checksums?.supportedTypes) && (checksums.supportedTypes as string[]).length > 0;
      // When the files_lock app is enabled, capabilities.files.locking contains a version string.
      const files = caps?.files as Record<string, unknown> | undefined;
      hasFilesLocking = files?.locking != null && files.locking !== false;
      // capabilities.dav.bulkupload (a version string) when supported; absent => per-file PUT.
      const dav = caps?.dav as Record<string, unknown> | undefined;
      hasBulkUpload = dav?.bulkupload != null && dav.bulkupload !== false;
    }

    const syncToken = await this.getSyncToken();

    // Detection comes from what the probes ANSWERED. Capabilities is the primary witness (every flag above derives from it);
    // /status.php is the second, so a genuine Nextcloud with OCS closed off (401/403) is not misfiled as plain WebDAV.
    // Neither answering means WebDAVFactory should use StandardWebDAVClient.
    const isNextcloud = ocsAnswered || /nextcloud/i.test(statusProductName);

    this.features = {
      isNextcloud,
      version,
      hasChecksums,
      hasFilesLocking,
      hasBulkUpload,
      syncToken,
    };
    return this.features;
  }

  async getFiles(path: string): Promise<RemoteFileInfo[]> {
    const res = await this.reqReadonly({
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
    // A 404 on the vault folder itself is NOT an empty listing (issue #50, docs/spec.md §5.2): an empty listing drives absence-based
    // deletion, a missing folder drives a re-seed. Subpaths keep the empty meaning.
    if (res.status === 404) {
      if (path === '') throw new RemoteRootMissingError();
      return [];
    }
    if (res.status !== 207) throw new NetworkError(res.status, res.text, 'PROPFIND');
    return await this.parsePropfindResponse(res.text, { op: 'getFiles', path, status: res.status, method: 'PROPFIND' });
  }

  // Depth:0 state of ONE file (docs/spec.md §5.7), parsed by the SAME parsePropfindResponse as the full scan so processRemoteFile
  // can be reused. A collection yields no entry, hence null. Unlike getFiles, a non-207 other than 404 THROWS: reading an
  // ambiguous failure as "absent" would send the caller down the create path and blind-overwrite the file.
  async statFile(remotePath: string): Promise<RemoteFileInfo | null> {
    const res = await this.reqReadonly({
      url: this.remoteUrl(remotePath),
      method: 'PROPFIND',
      headers: {
        Authorization: this.authHeader,
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
        ...NO_CACHE_HEADERS,
      },
      body: PROPFIND_BODY,
      throw: false,
    });
    if (res.status === 404) return null; // no such file (or its parent folder does not exist)
    if (res.status !== 207) throw new NetworkError(res.status, res.text, 'PROPFIND');
    const entries = await this.parsePropfindResponse(res.text, { op: 'statFile', path: remotePath, status: res.status, method: 'PROPFIND' });
    return entries[0] ?? null;
  }

  async getRootEtag(): Promise<string | null> {
    // One Depth:0 PROPFIND on the vault root (docs/spec.md §8a.5): Nextcloud propagates descendant changes to the root ETag.
    // Never throws; any non-207, unreadable body or other error yields null so the caller full-scans.
    try {
      const res = await this.reqReadonly({
        url: this.remoteUrl(''),
        method: 'PROPFIND',
        headers: { Authorization: this.authHeader, Depth: '0', 'Content-Type': 'application/xml; charset=utf-8', ...NO_CACHE_HEADERS },
        body: PROPFIND_BODY,
        throw: false,
      });
      if (res.status !== 207) return null;
      const responses = readMultistatus(res.text, { op: 'getRootEtag', path: '', status: res.status, method: 'PROPFIND' });
      const etag = readProp(responses[0])
        ?.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent?.replace(/"/g, '') ?? null;
      return etag && etag.length > 0 ? etag : null;
    } catch {
      return null;
    }
  }

  async getDirectories(path: string): Promise<RemoteDirInfo[]> {
    const res = await this.reqReadonly({
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
    if (res.status !== 207) throw new NetworkError(res.status, res.text, 'PROPFIND');
    return await this.parsePropfindDirectories(res.text, { op: 'getDirectories', path, status: res.status, method: 'PROPFIND' });
  }

  async isRemoteDirEmpty(path: string): Promise<boolean> {
    // Depth:1 lists the collection plus its children; "empty" (rmdir semantics) iff the only response is the collection itself.
    // Conservative on any ambiguity, including an unreadable body, so a recursive DELETE never targets a dir that might hold data.
    const res = await this.reqReadonly({
      url: this.remoteUrl(path),
      method: 'PROPFIND',
      headers: { Authorization: this.authHeader, Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', ...NO_CACHE_HEADERS },
      body: PROPFIND_BODY,
      throw: false,
    });
    if (res.status !== 207) return false;
    let responses: Element[];
    try {
      responses = readMultistatus(res.text, { op: 'isRemoteDirEmpty', path, status: res.status, method: 'PROPFIND' });
    } catch {
      return false;
    }
    let children = 0;
    for (const resp of responses) {
      const href = readHref(resp);
      const rel = hrefToRelative(this.baseUrl, this.remoteBase, href);
      // rel === '' is the collection itself (or the base); any other entry is a child.
      if (rel !== null && rel !== '' && rel !== path) children++;
    }
    return children === 0;
  }

  // Fails if any level could not be created: watch mode tracks the folder right after this returns, and a tracked folder
  // the server lacks drives delete propagation (issue #46).
  async createDirectory(path: string): Promise<void> {
    // ensureRemoteDir MKCOLs every segment of the path it is given EXCEPT the last (it assumes a
    // trailing file name), so append a dummy segment to have `path` itself (and its ancestors) created.
    await ensureRemoteDir(
      { baseUrl: this.baseUrl, authHeader: this.authHeader, timeoutMs: this.timeoutMs },
      toRemotePath(this.remoteBase, `${path}/_`),
      this.createdDirs,
    );
  }

  async createVaultRoot(): Promise<VaultRootOutcome> {
    // A client whose remote base IS the files root has no vault folder to create; answering 'exists'
    // keeps the caller on its no-destructive-action path rather than inventing a re-seed.
    if (!this.remoteBase) return 'exists';
    const ctx = { baseUrl: this.baseUrl, authHeader: this.authHeader, timeoutMs: this.timeoutMs };
    // Ancestors are best-effort (as in the first upload); only the vault folder is judged strictly, since its 201-vs-405 decides
    // whether the caller may reset tracking and re-seed. The swallow is explicit: a transient 423 on an ancestor must not stop mkcolStrict.
    await ensureRemoteDir(ctx, this.remoteBase, this.createdDirs).catch(() => undefined);
    const outcome = await mkcolStrict(ctx, this.remoteBase);
    // A 201 means the vault folder was absent, so every cached "already created" entry under it is stale; otherwise an EMPTY
    // directory (no write to fail and re-drive MKCOL) never reappears after the re-seed.
    if (outcome === 'created') this.createdDirs.clear();
    return outcome;
  }

  async deleteCollection(path: string): Promise<void> {
    const res = await this.req({
      url: this.remoteUrl(path), method: 'DELETE', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false,
    });
    if (res.status === 404) return; // already gone — the desired end state.
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'DELETE');
  }

  async getChanges(syncToken: string): Promise<SyncChanges> {
    // Run the sync-collection REPORT scoped to the base folder (the Vault folder) only.
    const res = await this.req({
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
    if (res.status !== 207) throw new NetworkError(res.status, res.text, 'REPORT');
    return await this.parseSyncChanges(res.text, { op: 'getChanges', path: '', status: res.status, method: 'REPORT' });
  }

  async downloadFile(remotePath: string): Promise<ArrayBuffer> {
    const res = await this.reqReadonly({ url: this.remoteUrl(remotePath), method: 'GET', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false });
    if (res.status !== 200) throw new NetworkError(res.status, '', 'GET');
    // Return the bytes directly (no shared field) so concurrent downloads cannot race each other.
    return res.arrayBuffer;
  }

  // A PUT or DELETE just came back 423. Always throws: ServerLockedError naming the lock owner, or the plain NetworkError.
  // The owner lookup is best-effort and must never replace or hide the original 423 (docs/spec.md §6.5a).
  private async errorFor423(path: string, method: 'PUT' | 'DELETE', originalText: string): Promise<never> {
    try {
      const res = await this.reqReadonly({
        url: this.remoteUrl(path),
        method: 'PROPFIND',
        headers: { Authorization: this.authHeader, Depth: '0', 'Content-Type': 'application/xml; charset=utf-8', ...NO_CACHE_HEADERS },
        body: LOCKDISCOVERY_BODY,
        throw: false,
      });
      if (res.status === 207) {
        const owner = readLockDiscoveryOwner(res.text);
        if (owner) throw new ServerLockedError(path, method, owner);
      }
    } catch (err) {
      if (err instanceof ServerLockedError) throw err;
      // The lookup itself failed (transport error, unreadable body) — fall through to the plain
      // NetworkError below rather than let this failure mask the original 423.
    }
    throw new NetworkError(423, originalText, method);
  }

  async uploadFile(
    remotePath: string, data: ArrayBuffer, mtime?: number,
    opts?: { precomputedSha256?: string; ifMatchEtag?: string | null },
  ): Promise<void> {
    // PUT first and MKCOL the parents only on a missing parent, then retry once: drops the per-upload directory probe on the common path.
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

    let res = await this.req({ url: this.remoteUrl(remotePath), method: 'PUT', headers, body: data, throw: false });
    // Missing parent: create the ancestors, then retry the PUT once. Standard WebDAV answers 409, Nextcloud 404; handle both.
    let dirError: RemoteDirCreateError | null = null;
    if (res.status === 409 || res.status === 404) {
      dirError = await prepareMissingParentRetry({ baseUrl: this.baseUrl, authHeader: this.authHeader, timeoutMs: this.timeoutMs }, toRemotePath(this.remoteBase, remotePath), this.createdDirs);
      if (isTransportFailure(dirError)) throw dirError;
      res = await this.req({ url: this.remoteUrl(remotePath), method: 'PUT', headers, body: data, throw: false });
    }
    if (res.status === 412) throw new PreconditionFailedError(remotePath); // remote changed (If-Match)
    if (res.status === 423) {
      // A server-side lock explains the failure on its own; dirError (from a MISSING-parent retry, an unrelated cause)
      // never applies here. errorFor423 always throws.
      await this.errorFor423(remotePath, 'PUT', res.text);
    }
    // A parent we could not create explains the failure better than the PUT's own status, so it wins, but only after the retry had its chance.
    if (res.status < 200 || res.status >= 300) throw dirError ?? new NetworkError(res.status, res.text, 'PUT');
  }

  async recalcChecksum(remotePath: string): Promise<string | null> {
    // Nextcloud's ChecksumUpdatePlugin computes the hash server-side for an existing file
    // (no download) and persists it, returning it in the OC-Checksum response header.
    const res = await this.req({
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
    // Ensure the destination parent exists before MOVE. This deliberately does NOT drop stale cache entries: if the folder went away
    // after we created it, the MKCOL is skipped, the MOVE 404s, and the recovery below puts it back.
    const ctx = { baseUrl: this.baseUrl, authHeader: this.authHeader, timeoutMs: this.timeoutMs };
    const target = toRemotePath(this.remoteBase, newPath);
    // A failure here is DISCARDED on purpose. This call is speculative — it runs before the MOVE has
    // said anything — so it cannot explain a MOVE that fails for some entirely unrelated reason. Only
    // the recovery below, which the server's own "missing parent" answer triggers, may do that.
    await ensureRemoteDir(ctx, target, this.createdDirs).catch((err) => {
      if (!(err instanceof RemoteDirCreateError)) throw err;
    });
    const move = () => this.req({
      url: this.remoteUrl(oldPath),
      method: 'MOVE',
      headers: { Authorization: this.authHeader, Destination: this.remoteUrl(newPath), Overwrite: 'F', ...NO_CACHE_HEADERS },
      throw: false,
    });
    let res = await move();
    let dirError: RemoteDirCreateError | null = null;
    // Same missing-parent recovery as uploadFile: a destination folder another device deleted leaves a stale "already created" entry
    // that makes the MKCOL above a no-op.
    if (res.status === 409 || res.status === 404) {
      dirError = await prepareMissingParentRetry(ctx, target, this.createdDirs);
      if (isTransportFailure(dirError)) throw dirError;
      res = await move();
    }
    if (res.status === 412) throw new ConflictError(newPath);
    if (res.status < 200 || res.status >= 300) throw dirError ?? new NetworkError(res.status, res.text, 'MOVE');
  }

  async deleteFile(path: string, _expectedRemoteId: string): Promise<void> {
    const res = await this.req({
      url: this.remoteUrl(path), method: 'DELETE', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false,
    });
    // Blind delete: a 404 means already gone, the desired end state; no pre-deletion existence probe is needed.
    if (res.status === 404) return;
    // A server-side lock explains the failure on its own; errorFor423 always throws.
    if (res.status === 423) await this.errorFor423(path, 'DELETE', res.text);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'DELETE');
  }

  // Always null: Nextcloud's files DAV does not implement the sync-collection REPORT (Sabre answers 415), so sending it cost a
  // guaranteed-415 round-trip and wrote a server-side ERROR stack trace on every plugin load (issue #37, docs/spec.md §18).
  // getChanges() is kept: it is the only implementation of the incremental path should a token ever arrive.
  async getSyncToken(): Promise<string | null> {
    return null;
  }

  async remoteExists(remotePath: string): Promise<boolean> {
    // Targeted existence probe (PROPFIND Depth 0). Only a definitive 404 means "gone"; any other
    // status (incl. transient errors) is treated as "present" so callers never delete on ambiguity.
    try {
      const res = await this.reqReadonly({
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


  async listVersions(fileId: string): Promise<FileVersion[]> {
    if (!fileId) throw new FeatureUnsupportedError('versions');
    const collectionUrl = `${this.davBase('versions')}/versions/${encodeURIComponent(fileId)}`;
    const res = await this.reqReadonly({
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
    if (res.status !== 207) throw new NetworkError(res.status, res.text, 'PROPFIND');
    return this.parseVersions(res.text, fileId);
  }

  async getVersionContent(version: FileVersion, fileId: string): Promise<ArrayBuffer> {
    if (!fileId) throw new FeatureUnsupportedError('versions');
    const res = await this.reqReadonly({
      url: this.versionUrl(version, fileId),
      method: 'GET',
      headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS },
      throw: false,
    });
    if (res.status !== 200) throw new NetworkError(res.status, '', 'GET');
    return res.arrayBuffer;
  }

  async restoreVersion(version: FileVersion, fileId: string): Promise<void> {
    if (!fileId) throw new FeatureUnsupportedError('versions');
    const destination = `${this.davBase('versions')}/restore/target`;
    const res = await this.req({
      url: this.versionUrl(version, fileId),
      method: 'MOVE',
      headers: { Authorization: this.authHeader, Destination: destination, ...NO_CACHE_HEADERS },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'MOVE');
  }

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


  async uploadChunked(
    remotePath: string, data: ArrayBuffer, chunkSizeBytes: number,
    opts?: { precomputedSha256?: string; ifMatchEtag?: string | null },
  ): Promise<void> {
    const uploadId = `obsidian-${this.settings.deviceId.slice(-8)}-${Date.now()}`;
    const sessionUrl = `${this.davBase('uploads')}/${uploadId}`;
    const finalUrl = this.remoteUrl(remotePath);
    const total = data.byteLength;

    // Compute the SHA-256 once here; reuse it for both the OC-Checksum header and
    // post-assembly verification so the full buffer is never hashed more than once.
    const sum = await sha256(data);

    try {
      const mk = await this.req({ url: sessionUrl, method: 'MKCOL', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false });
      if (mk.status < 200 || mk.status >= 300) throw new NetworkError(mk.status, mk.text, 'MKCOL');

      // PUT each chunk named by its start byte offset (15-digit zero-padded) so lexical order = assembly order.
      for (let offset = 0; offset < total; offset += chunkSizeBytes) {
        const end = Math.min(offset + chunkSizeBytes, total);
        const chunk = data.slice(offset, end);
        const chunkName = String(offset).padStart(15, '0');
        const put = await this.req({
          url: `${sessionUrl}/${chunkName}`,
          method: 'PUT',
          headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS },
          body: chunk,
          throw: false,
        });
        if (put.status < 200 || put.status >= 300) throw new NetworkError(put.status, put.text, 'PUT');
      }

      // Ensure the final file's parent exists, then assemble by MOVE-ing .file. Drop stale "already created" entries first so a folder
      // another device deleted is re-created. The failure is kept but not acted on yet: the MOVE fails for many reasons unrelated to the parent.
      const dirError = await prepareMissingParentRetry({ baseUrl: this.baseUrl, authHeader: this.authHeader, timeoutMs: this.timeoutMs }, toRemotePath(this.remoteBase, remotePath), this.createdDirs);
      const moveHeaders: Record<string, string> = {
        Authorization: this.authHeader,
        Destination: finalUrl,
        'OC-Total-Length': String(total),
        // Persist the SHA-256 on the assembled file (same rationale as uploadFile).
        'OC-Checksum': `SHA256:${sum}`,
        ...NO_CACHE_HEADERS,
      };
      // If-Match optimistic concurrency on the assembling MOVE (mirrors uploadFile): a remote
      // changed since this etag returns 412, mapped below to PreconditionFailedError.
      if (opts?.ifMatchEtag) moveHeaders['If-Match'] = `"${opts.ifMatchEtag.replace(/^"|"$/g, '')}"`;
      const move = await this.req({
        url: `${sessionUrl}/.file`,
        method: 'MOVE',
        headers: moveHeaders,
        throw: false,
      });
      if (move.status === 412) throw new PreconditionFailedError(remotePath); // remote changed (If-Match)
      // The assembling MOVE has no retry (the upload session is single-use), so when the server says the parent is missing, the level
      // we could not create IS the explanation, instead of "HTTP 404 (MOVE)". Any other failure is reported as itself.
      const parentMissing = move.status === 404 || move.status === 409;
      if (move.status < 200 || move.status >= 300) {
        throw (parentMissing && dirError) ? dirError : new NetworkError(move.status, move.text, 'MOVE');
      }

      // Verify the checksum after assembly (FR-012), passing the precomputed hash to avoid hashing the buffer twice.
      await this.verifyRemoteChecksum(remotePath, data, sum);
    } catch (err) {
      // On abort, discard the session so no incomplete file is left at the final path (FR-011).
      await this.req({ url: sessionUrl, method: 'DELETE', headers: { Authorization: this.authHeader, ...NO_CACHE_HEADERS }, throw: false }).catch(() => undefined);
      throw err;
    }
  }

  // Fetches the remote checksum after upload and compares it with the local SHA-256; skipped if unavailable.
  // A precomputed hash avoids rehashing the same buffer (uploadChunked).
  private async verifyRemoteChecksum(remotePath: string, data: ArrayBuffer, precomputed?: string): Promise<void> {
    const res = await this.reqReadonly({
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


  async lockFile(remotePath: string): Promise<string> {
    const res = await this.req({
      url: this.remoteUrl(remotePath),
      method: 'LOCK',
      headers: { Authorization: this.authHeader, 'X-User-Lock': '1', ...NO_CACHE_HEADERS },
      throw: false,
    });
    if (res.status === 423) throw new FileLockedError(remotePath);
    if (res.status < 200 || res.status >= 300) throw new NetworkError(res.status, res.text, 'LOCK');
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
      await this.req({
        url: this.remoteUrl(remotePath),
        method: 'UNLOCK',
        headers: { Authorization: this.authHeader, 'Lock-Token': token, 'X-User-Lock': '1', ...NO_CACHE_HEADERS },
        throw: false,
      });
    } catch {
      // Best-effort. A leftover lock is recovered on the next sync (FR-016).
    }
  }

  private async parsePropfindResponse(
    xml: string, ctx: { op: string; path: string; status: number; method: 'PROPFIND' | 'REPORT' },
  ): Promise<RemoteFileInfo[]> {
    const results: RemoteFileInfo[] = [];
    const responses = readMultistatus(xml, ctx);
    for (let i = 0; i < responses.length; i++) {
      // Yield periodically so parsing a large Depth:infinity listing does not freeze the UI or trigger an Android ANR (FR-027).
      if (i > 0 && i % PARSE_YIELD_EVERY === 0) await new Promise((r) => window.setTimeout(r, 0));
      const resp = responses[i];
      const prop = readProp(resp);
      if (!prop) continue;
      if (readIsCollection(prop)) continue; // files only; parsePropfindDirectories keeps the inverse

      const path = hrefToRelative(this.baseUrl, this.remoteBase, readHref(resp));
      if (path === null || path === '') continue; // Skip entries outside the base folder or the folder itself
      const { etag, size, lastModified } = readDavProps(prop);
      const { checksum, fileId } = readOwncloudProps(prop);
      results.push({ path, fileId, checksum, etag, size, lastModified });
    }
    return results;
  }

  private async parsePropfindDirectories(
    xml: string, ctx: { op: string; path: string; status: number; method: 'PROPFIND' | 'REPORT' },
  ): Promise<RemoteDirInfo[]> {
    const results: RemoteDirInfo[] = [];
    const responses = readMultistatus(xml, ctx);
    for (let i = 0; i < responses.length; i++) {
      if (i > 0 && i % PARSE_YIELD_EVERY === 0) await new Promise((r) => window.setTimeout(r, 0));
      const resp = responses[i];
      const prop = readProp(resp);
      if (!prop) continue;
      if (!readIsCollection(prop)) continue; // mirror of parsePropfindResponse: here we KEEP only collections.

      const path = hrefToRelative(this.baseUrl, this.remoteBase, readHref(resp));
      if (path === null || path === '') continue; // outside the base folder, or the base folder itself
      const { etag, lastModified } = readDavProps(prop);
      const { fileId } = readOwncloudProps(prop);
      results.push({ path, fileId, etag, lastModified });
    }
    return results;
  }

  private async parseSyncChanges(
    xml: string, ctx: { op: string; path: string; status: number; method: 'PROPFIND' | 'REPORT' },
  ): Promise<SyncChanges> {
    const modified: RemoteFileInfo[] = [];
    const deleted: string[] = [];
    // Validate FIRST: an unreadable body must never resolve to "no changes, empty token", which reads as "in sync" and stalls the vault.
    const responses = readMultistatus(xml, ctx);
    const newSyncToken = readSyncToken(xml);

    for (let i = 0; i < responses.length; i++) {
      // Yield periodically (anti-ANR) — see parsePropfindResponse.
      if (i > 0 && i % PARSE_YIELD_EVERY === 0) await new Promise((r) => window.setTimeout(r, 0));
      const resp = responses[i];
      const path = hrefToRelative(this.baseUrl, this.remoteBase, readHref(resp));
      if (path === null || path === '') continue; // Skip entries outside the base folder or the folder itself
      if (readStatusText(resp)?.includes('404')) {
        deleted.push(path);
        continue;
      }
      const prop = readProp(resp);
      if (!prop) continue;
      const { etag, size, lastModified } = readDavProps(prop);
      const { checksum, fileId } = readOwncloudProps(prop);
      modified.push({ path, fileId, checksum, etag, size, lastModified });
    }
    return { modified, deleted, newSyncToken };
  }
}
