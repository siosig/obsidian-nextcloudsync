// Minimal WebDAV client for asserting the SERVER side of a b-3 round trip.
//
// Why a second client exists at all: the plugin under test talks to Nextcloud through Obsidian's
// mobile `requestUrl` inside the Android WebView, which is precisely the implementation b-3 is here
// to exercise. Verifying the result with that same implementation would make the test agree with
// itself. These helpers run in the wdio process (plain Node on the AVD host) and reach the server
// independently, so a Capacitor-side encoding or body-length bug shows up as a mismatch instead of
// cancelling out.
//
// Deliberately tiny — PUT / GET / DELETE / MKCOL and nothing else. It is an assertion aid, not a
// second implementation of the sync engine.
import { browser } from '@wdio/globals';
import { requireAndroidEnv } from './env';

function authHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

/** Joins the DAV base with a vault-relative path, percent-encoding each segment exactly once. */
export function davUrl(base: string, vaultPath: string): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  const encoded = vaultPath
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `${root}${encoded}`;
}

export interface RemoteFile {
  status: number;
  /** Raw bytes as returned by the server; compared byte-for-byte, never via a decoded string. */
  body: Buffer;
}

export class RemoteProbe {
  private readonly base: string;
  private readonly auth: string;

  constructor(base: string, user: string, password: string) {
    this.base = base;
    this.auth = authHeader(user, password);
  }

  /** Builds a probe from the resolved b-3 environment. Throws if the connection is not usable. */
  static fromEnv(vaultFolder = ''): RemoteProbe {
    const env = requireAndroidEnv();
    const { NEXTCLOUD_SERVER_URL, NEXTCLOUD_USER, NEXTCLOUD_PASSWORD } = env.values;
    if (!NEXTCLOUD_SERVER_URL || !NEXTCLOUD_USER || !NEXTCLOUD_PASSWORD) {
      throw new Error(`b-3 remote probe needs NEXTCLOUD_* (missing: ${env.missing.join(', ')})`);
    }
    const root = vaultFolder
      ? `${NEXTCLOUD_SERVER_URL.replace(/\/$/, '')}/${encodeURIComponent(vaultFolder)}/`
      : NEXTCLOUD_SERVER_URL;
    return new RemoteProbe(root, NEXTCLOUD_USER, NEXTCLOUD_PASSWORD);
  }

  /**
   * Builds a probe scoped to the folder the plugin actually syncs into.
   *
   * The plugin does NOT sync to the DAV root: WebDAVFactory derives its remote base from
   * `app.vault.getName()`, so everything lands under `<serverUrl>/<vaultName>/`. The vault name is
   * generated per session by wdio-obsidian-service, so it has to be read from the device rather than
   * configured. A probe pointed at the root finds nothing and reports it as "the file never arrived",
   * which is indistinguishable from a sync failure — this is the one place that must not be guessed.
   */
  static async forCurrentVault(): Promise<RemoteProbe> {
    const vaultName = (await browser.executeObsidian(({ app }) => app.vault.getName())) as string;
    // Seed the folder: scenarios that put a file on the server BEFORE the first sync would otherwise
    // write into a collection that does not exist yet. MKCOL is idempotent enough here — an existing
    // collection answers 405, which is a success for our purposes.
    const rootProbe = RemoteProbe.fromEnv();
    await rootProbe.mkcol(vaultName).catch(() => undefined);
    return RemoteProbe.fromEnv(vaultName);
  }

  private async request(method: string, vaultPath: string, body?: Buffer): Promise<RemoteFile> {
    const res = await fetch(davUrl(this.base, vaultPath), {
      method,
      headers: { Authorization: this.auth },
      body: body as unknown as BodyInit | undefined,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: buf };
  }

  /** Writes a file server-side so a later sync has something to pull down. */
  put(vaultPath: string, content: Buffer | string): Promise<RemoteFile> {
    return this.request('PUT', vaultPath, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'));
  }

  get(vaultPath: string): Promise<RemoteFile> {
    return this.request('GET', vaultPath);
  }

  delete(vaultPath: string): Promise<RemoteFile> {
    return this.request('DELETE', vaultPath);
  }

  mkcol(vaultPath: string): Promise<RemoteFile> {
    return this.request('MKCOL', vaultPath);
  }

  /** Best-effort teardown: a leftover fixture must never fail the next run. */
  async removeQuietly(vaultPath: string): Promise<void> {
    try {
      await this.delete(vaultPath);
    } catch {
      // ignored on purpose — cleanup is not an assertion
    }
  }
}
