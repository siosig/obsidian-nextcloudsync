import { App, Notice } from 'obsidian';
import { DavSyncSettings, NextcloudFeatures, UnsupportedVersionError } from '../types';
import { IWebDAVClient } from './IWebDAVClient';
import { NextcloudClient } from './NextcloudClient';
import { StandardWebDAVClient } from './StandardWebDAVClient';
import { CredentialsNotFoundError } from '../types';
import { normalizeBase } from './remotePath';

const MIN_NEXTCLOUD_VERSION = '33.0.4';

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export class WebDAVFactory {
  constructor(
    private readonly app: App,
    private readonly settings: DavSyncSettings,
    private readonly appPassword: string | null,
  ) {}

  async createClient(): Promise<{ client: IWebDAVClient; features: NextcloudFeatures }> {
    if (!this.appPassword) throw new CredentialsNotFoundError();

    // Fix the remote sync target's base folder to the Vault name (isolating each Vault on the server).
    const remoteBase = normalizeBase(this.app.vault.getName());

    const nextcloudClient = new NextcloudClient(this.settings, this.appPassword, remoteBase);
    let features: NextcloudFeatures;

    try {
      features = await nextcloudClient.connect();
    } catch {
      // Not Nextcloud or connection failed: try standard WebDAV
      const stdClient = new StandardWebDAVClient(this.settings, this.appPassword, remoteBase);
      features = await stdClient.connect();
      return { client: stdClient, features };
    }

    // Version check
    if (features.version && compareVersions(features.version, MIN_NEXTCLOUD_VERSION) < 0) {
      new Notice(
        `⚠️ Nextcloud ${features.version} is not supported. Please upgrade to ${MIN_NEXTCLOUD_VERSION} or later.`,
        8000,
      );
      throw new UnsupportedVersionError(features.version);
    }

    return { client: nextcloudClient, features };
  }
}
