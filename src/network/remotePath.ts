import { requestUrl } from 'obsidian';

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
 * Strip the base folder from a files-root-relative remote path to get a Vault-relative path.
 * Returns null when the path is not under the base folder (so it is ignored as out of scope).
 */
export function fromRemotePath(base: string, full: string): string | null {
  const f = (full ?? '').replace(/^\/+/, '');
  if (!base) return f;
  if (f === base) return ''; // the base folder itself
  const prefix = `${base}/`;
  return f.startsWith(prefix) ? f.slice(prefix.length) : null;
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
      headers: { Authorization: ctx.authHeader },
      throw: false,
    });
    // 201=created / 405=already exists are both fine; continue best-effort on other codes too.
    createdCache.add(acc);
  }
}
