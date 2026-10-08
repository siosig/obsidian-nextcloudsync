// Minimal WebDAV client (PUT / GET / DELETE / MKCOL) for asserting the SERVER side of a b-3 round trip. The plugin
// talks to Nextcloud through Android's mobile `requestUrl`, so verifying with that same implementation would make
// the test agree with itself. These helpers run in plain Node in the wdio runner and reach the server independently.
import { browser } from '@wdio/globals';
import { requireAndroidEnv } from './env';

function authHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

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
  // Raw bytes as returned by the server; compared byte-for-byte, never via a decoded string.
  body: Buffer;
}

export class RemoteProbe {
  private readonly base: string;
  private readonly auth: string;

  constructor(base: string, user: string, password: string) {
    this.base = base;
    this.auth = authHeader(user, password);
  }

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

  // The plugin syncs into `<serverUrl>/<vaultName>/` (WebDAVFactory derives it from `app.vault.getName()`), and
  // wdio-obsidian-service generates the vault name per session, so read it from the device; a probe at the root
  // finds nothing and looks like a sync failure.
  static async forCurrentVault(): Promise<RemoteProbe> {
    const vaultName = (await browser.executeObsidian(({ app }) => app.vault.getName())) as string;
    // Seed the folder so a file put on the server before the first sync has a collection to land in. An existing
    // collection answers 405, which is fine here.
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

  // A leftover fixture must never fail the next run.
  async removeQuietly(vaultPath: string): Promise<void> {
    try {
      await this.delete(vaultPath);
    } catch {
      // Cleanup is not an assertion.
    }
  }
}
