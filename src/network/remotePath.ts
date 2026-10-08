import { NO_CACHE_HEADERS } from './noCacheHeaders';
import { requestUrlWithTimeout } from './requestWithTimeout';
import { NetworkError, RemoteDirCreateError, VaultRootOutcome } from '../types';
import { RemoteDirCache, ancestorsOf } from './RemoteDirCache';

// Maps between Vault-relative paths (what the engine uses) and files-root-relative remote paths (<base>/...);
// the local/remote asymmetry stays inside the client layer.

export function normalizeBase(name: string): string {
  return (name ?? '').replace(/^\/+|\/+$/g, '');
}

export function toRemotePath(base: string, rel: string): string {
  const r = (rel ?? '').replace(/^\/+/, '');
  if (!base) return r;
  return r ? `${base}/${r}` : base;
}

// Rejects paths that could escape the Vault root (`..` segment, leading slash, backslash, drive letter). A malicious server
// could craft an href that decodes to one and reach local file sinks (write/delete/rename); callers map an unsafe path to null.
export function isSafeVaultRelativePath(rel: string): boolean {
  if (!rel) return true; // empty = the base folder itself; callers handle separately
  if (rel.startsWith('/') || rel.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false; // Windows drive letter (e.g. C:\)
  return !rel.split('/').includes('..');
}

// Null when the path is not under the base folder or is unsafe (traversal/absolute); such entries are ignored as out of scope.
export function fromRemotePath(base: string, full: string): string | null {
  const f = (full ?? '').replace(/^\/+/, '');
  if (!base) return isSafeVaultRelativePath(f) ? f : null;
  if (f === base) return ''; // the base folder itself
  const prefix = `${base}/`;
  if (!f.startsWith(prefix)) return null;
  const rel = f.slice(prefix.length);
  return isSafeVaultRelativePath(rel) ? rel : null;
}

// baseUrl may point at an arbitrary subfolder under the WebDAV files root, so strip its own path first, then the base folder
// (the Vault name). Stripping only /remote.php/dav/files/<user>/ is insufficient. Null when the entry is outside the configured base.
export function hrefToRelative(baseUrl: string, base: string, href: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(href, baseUrl).pathname;
  } catch {
    pathname = href;
  }
  pathname = decodeURIComponent(pathname);
  const basePath = decodeURIComponent(new URL(baseUrl).pathname).replace(/\/+$/, '');
  let fromRoot = basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
  fromRoot = fromRoot.replace(/^\/+|\/+$/g, '');
  return fromRemotePath(base, fromRoot);
}

// One scheme for every platform: percent-encode each path segment with encodeURIComponent and keep `/` (surrogate pairs survive;
// the same scheme as webdav-client's encodePath()). Deliberately NO iOS branch (issue #25): passing the path raw left a space
// unencoded and every path containing one 404'd. A literal %20 in a remote folder name is better explained by the reverse proxy
// (nginx re-normalising the URI, Apache RewriteRule without [NE]), so ask for its configuration before touching this (docs/spec.md §11.1).
export function encodeRemoteUrl(baseUrl: string, remotePath: string): string {
  if (!remotePath) return baseUrl;
  const encodedPath = remotePath.split('/').map(encodeURIComponentSegment).join('/');
  return `${baseUrl}/${encodedPath}`;
}

// encodeURIComponent as a standalone reference so .map() never receives the index argument.
function encodeURIComponentSegment(segment: string): string {
  return encodeURIComponent(segment);
}

// The Server URL may end in a subfolder with spaces or non-ASCII characters and is the base of every request URL, so encode it exactly once.
// A `%` anywhere means it was pasted already encoded and is returned untouched (re-encoding turns %20 into %2520);
// encodeURI keeps the scheme, host, port and path separators.
export function encodeServerUrl(url: string): string {
  if (!url || url.includes('%')) return url;
  return encodeURI(url);
}

// Creates the parent collections of a remote file path via MKCOL (PUT does not create parents). Each level goes through the cache:
// one MKCOL per collection in flight, and only 201/405 count as created. Throws RemoteDirCreateError at the FIRST level that
// cannot be created, without trying its children; callers that can progress anyway (a PUT into an existing folder that refuses MKCOL) catch it.
export async function ensureRemoteDir(
  ctx: { baseUrl: string; authHeader: string; timeoutMs?: number },
  remoteFilePath: string,
  createdCache: RemoteDirCache,
): Promise<void> {
  for (const dir of ancestorsOf(remoteFilePath)) {
    await createdCache.ensure(dir, async (path) => {
      const res = await requestUrlWithTimeout({
        url: encodeRemoteUrl(ctx.baseUrl, path),
        method: 'MKCOL',
        headers: { Authorization: ctx.authHeader, ...NO_CACHE_HEADERS },
        throw: false,
      }, ctx.timeoutMs ?? 0);
      return res.status;
    });
  }
}

// Prepares a retry of a write whose parent the server says is missing (PUT/MOVE 404/409): forgets cached ancestors (another device may
// have deleted one) and re-issues the MKCOLs. Reports failure instead of throwing, since a folder can exist while MKCOL is refused (403)
// and the retried PUT then succeeds. status 0 (timeout, dropped connection) means the parent is certainly still missing; see isTransportFailure.
export function isTransportFailure(dirError: RemoteDirCreateError | null): dirError is RemoteDirCreateError {
  return dirError !== null && dirError.status === 0;
}

export async function prepareMissingParentRetry(
  ctx: { baseUrl: string; authHeader: string; timeoutMs?: number },
  remoteFilePath: string,
  createdCache: RemoteDirCache,
): Promise<RemoteDirCreateError | null> {
  createdCache.forgetAncestorsOf(remoteFilePath);
  try {
    await ensureRemoteDir(ctx, remoteFilePath, createdCache);
    return null;
  } catch (err) {
    if (err instanceof RemoteDirCreateError) return err;
    throw err;
  }
}

// MKCOL one collection and REPORT the status, to answer whether the vault folder was really missing: a listing 404 alone cannot be trusted.
// 201 proves absence, 405 proves the listing was wrong, anything else is an error. Does NOT use the createdDirs cache: the server must be asked every time.
export async function mkcolStrict(
  ctx: { baseUrl: string; authHeader: string; timeoutMs?: number },
  remotePath: string,
): Promise<VaultRootOutcome> {
  const res = await requestUrlWithTimeout({
    url: encodeRemoteUrl(ctx.baseUrl, remotePath),
    method: 'MKCOL',
    headers: { Authorization: ctx.authHeader, ...NO_CACHE_HEADERS },
    throw: false,
  }, ctx.timeoutMs ?? 0);
  if (res.status === 201) return 'created';
  if (res.status === 405) return 'exists';
  throw new NetworkError(res.status, res.text, 'MKCOL');
}
