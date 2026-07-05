import { requestUrl } from 'obsidian';
import { NO_CACHE_HEADERS } from './noCacheHeaders';

/**
 * Helpers for converting between the remote base folder (the Vault name) and paths.
 *
 * The SyncEngine always works with Vault-relative paths (e.g. `Notes/a.md`), and
 * the WebDAV client layer transparently maps them into / out of the base folder
 * using these helpers. This keeps the asymmetric mapping between local (the whole
 * Vault) and remote (`/<VaultName>/...`) contained inside the client.
 */

/** Strip leading/trailing slashes and normalize as a remote folder name. */
export function normalizeBase(name: string): string {
  return (name ?? '').replace(/^\/+|\/+$/g, '');
}

/** Join the base folder and a Vault-relative path into a files-root-relative remote path. */
export function toRemotePath(base: string, rel: string): string {
  const r = (rel ?? '').replace(/^\/+/, '');
  if (!base) return r;
  return r ? `${base}/${r}` : base;
}

/**
 * Reject Vault-relative paths that could escape the Vault root or are absolute.
 *
 * A legitimate Vault-relative path never contains a `..` segment, a leading slash, a
 * backslash, or a Windows drive-letter prefix. A malicious or compromised server could
 * craft a PROPFIND/REPORT href that decodes to such a path; without this guard it would
 * reach local file sinks (download write, delete, rename) and allow arbitrary-path access
 * outside the Vault. Treated as out of scope (callers map an unsafe path to null).
 */
export function isSafeVaultRelativePath(rel: string): boolean {
  if (!rel) return true; // empty = the base folder itself; callers handle separately
  if (rel.startsWith('/') || rel.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false; // Windows drive letter (e.g. C:\)
  return !rel.split('/').includes('..');
}

/**
 * Strip the base folder from a files-root-relative remote path to get a Vault-relative path.
 * Returns null when the path is not under the base folder, or when the resulting path is
 * unsafe (path traversal / absolute), so it is ignored as out of scope.
 */
export function fromRemotePath(base: string, full: string): string | null {
  const f = (full ?? '').replace(/^\/+/, '');
  if (!base) return isSafeVaultRelativePath(f) ? f : null;
  if (f === base) return ''; // the base folder itself
  const prefix = `${base}/`;
  if (!f.startsWith(prefix)) return null;
  const rel = f.slice(prefix.length);
  return isSafeVaultRelativePath(rel) ? rel : null;
}

/**
 * Convert a PROPFIND/REPORT response `href` into a Vault-relative path.
 *
 * The server returns an href rooted at the server origin that contains the full DAV
 * path (e.g. `/nextcloud/remote.php/dav/files/<user>/Documents/obsidian/<Vault>/a.md`),
 * whereas `baseUrl` may point at an arbitrary subfolder under the WebDAV files root
 * (the configured Server URL). We therefore strip the baseUrl's own path to obtain the
 * base-folder-relative path, then strip the base folder (the Vault name) via
 * {@link fromRemotePath}. Returns null when the entry is outside the configured base
 * (so it is ignored as out of scope).
 *
 * Note: stripping only `/remote.php/dav/files/<user>/` is insufficient, because the
 * Server URL can include extra path segments beyond the files root.
 */
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

/** Build a WebDAV URL from a files-root-relative path (keep slashes, URL-encode each segment). */
export function encodeRemoteUrl(baseUrl: string, remotePath: string): string {
  if (!remotePath) return baseUrl;
  return `${baseUrl}/${encodeURIComponent(remotePath).replace(/%2F/g, '/')}`;
}

/**
 * Idempotently create the parent collections (directories) of a remote file path via MKCOL.
 * Existing collections (405) are ignored, and createdCache suppresses duplicate requests.
 * Required before upload because WebDAV PUT does not auto-create parent directories.
 */
export async function ensureRemoteDir(
  ctx: { baseUrl: string; authHeader: string },
  remoteFilePath: string,
  createdCache: Set<string>,
): Promise<void> {
  const segments = remoteFilePath.split('/').slice(0, -1); // drop the trailing file name
  let acc = '';
  for (const seg of segments) {
    if (!seg) continue;
    acc = acc ? `${acc}/${seg}` : seg;
    if (createdCache.has(acc)) continue;
    await requestUrl({
      url: encodeRemoteUrl(ctx.baseUrl, acc),
      method: 'MKCOL',
      headers: { Authorization: ctx.authHeader, ...NO_CACHE_HEADERS },
      throw: false,
    });
    // 201=created / 405=already exists are both fine; continue best-effort on other codes too.
    createdCache.add(acc);
  }
}
