import { NO_CACHE_HEADERS } from './noCacheHeaders';
import { requestUrlWithTimeout } from './requestWithTimeout';

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

/**
 * Build a WebDAV URL from a files-root-relative path.
 *
 * ONE scheme for every platform: percent-encode each path segment, keep `/` as the separator.
 * `encodeURIComponent` escapes both the ASCII characters that carry structural meaning in a URL
 * (space, `#`, `?`, `%`, `&`, ...) and every non-ASCII character as UTF-8, and it operates on code
 * points, so surrogate pairs (emoji) survive. This is byte-for-byte the scheme webdav-client uses
 * (`encodePath()`: protect the slashes, `encodeURIComponent`, restore the slashes), which
 * remotely-save ships to iOS users at scale with no platform branch of its own.
 *
 * Why there is deliberately NO iOS branch here (feature 065, issue #25) — do not reintroduce one:
 * feature 061 made iOS pass the path RAW, on the theory that the native request layer re-encodes
 * every character exactly once and would otherwise double-escape our `%` into `%25`. Issue #25
 * disproved the theory: a raw space is not encoded there, so every path containing one 404s (a raw
 * `&`, legal in a URL path, went through fine — which is what pins the failure on the unencoded
 * space rather than on the request layer as a whole).
 *
 * The observation that motivated 061 (a pre-encoded `%20` surfacing as a LITERAL `%20` in the
 * remote folder name) is equally well explained by the reverse proxy in front of Nextcloud:
 * nginx rebuilds a normalized — i.e. percent-decoded — URI whenever `proxy_pass` carries a URI or a
 * `rewrite` changed it, and Apache's `RewriteRule` double-encodes any percent-encoding already
 * present unless `[NE]` is set. Both reporters ran the same client (Obsidian 1.12.7 / iOS 26.5.x),
 * so the difference between them is far more likely server-side than client-side.
 *
 * If a literal-`%XX` name is ever reported again: ask for the reverse-proxy configuration BEFORE
 * touching this function. Flipping the scheme back would re-break issue #25 for everyone.
 */
export function encodeRemoteUrl(baseUrl: string, remotePath: string): string {
  if (!remotePath) return baseUrl;
  const encodedPath = remotePath.split('/').map(encodeURIComponentSegment).join('/');
  return `${baseUrl}/${encodedPath}`;
}

/** `encodeURIComponent` as a standalone reference so `.map()` never receives the index argument. */
function encodeURIComponentSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Normalize the user-entered Server URL so its path is percent-encoded exactly once.
 *
 * The Server URL may end in an arbitrary subfolder (the only way to place the vault somewhere other
 * than the WebDAV files root), and that subfolder can contain a space or non-ASCII characters. We
 * pass this value through as the base of every request URL, so leaving it raw reproduces the very
 * failure {@link encodeRemoteUrl} exists to prevent.
 *
 * A `%` anywhere in the value means the user pasted an already-encoded URL (browsers show them that
 * way), so it is returned untouched — encoding it again would turn `%20` into `%2520`. This is the
 * same guard remotely-save applies to its own address setting. `encodeURI` (not
 * `encodeURIComponent`) is used so the scheme, host, port and path separators survive.
 */
export function encodeServerUrl(url: string): string {
  if (!url || url.includes('%')) return url;
  return encodeURI(url);
}

/**
 * Idempotently create the parent collections (directories) of a remote file path via MKCOL.
 * Existing collections (405) are ignored, and createdCache suppresses duplicate requests.
 * Required before upload because WebDAV PUT does not auto-create parent directories.
 */
export async function ensureRemoteDir(
  ctx: { baseUrl: string; authHeader: string; timeoutMs?: number },
  remoteFilePath: string,
  createdCache: Set<string>,
): Promise<void> {
  const segments = remoteFilePath.split('/').slice(0, -1); // drop the trailing file name
  let acc = '';
  for (const seg of segments) {
    if (!seg) continue;
    acc = acc ? `${acc}/${seg}` : seg;
    if (createdCache.has(acc)) continue;
    await requestUrlWithTimeout({
      url: encodeRemoteUrl(ctx.baseUrl, acc),
      method: 'MKCOL',
      headers: { Authorization: ctx.authHeader, ...NO_CACHE_HEADERS },
      throw: false,
    }, ctx.timeoutMs ?? 0);
    // 201=created / 405=already exists are both fine; continue best-effort on other codes too.
    createdCache.add(acc);
  }
}
