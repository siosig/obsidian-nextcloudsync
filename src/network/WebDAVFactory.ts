import { App } from 'obsidian';
import { DavSyncSettings, NextcloudFeatures } from '../types';
import { IWebDAVClient } from './IWebDAVClient';
import { NextcloudClient } from './NextcloudClient';
import { StandardWebDAVClient } from './StandardWebDAVClient';
import { CredentialsNotFoundError, MaintenanceModeError } from '../types';
import { normalizeBase } from './remotePath';

export class WebDAVFactory {
  constructor(
    private readonly app: App,
    private readonly settings: DavSyncSettings,
    private readonly appPassword: string | null,
    private readonly diag?: (msg: string) => void,
  ) {}

  async createClient(): Promise<{ client: IWebDAVClient; features: NextcloudFeatures }> {
    if (!this.appPassword) throw new CredentialsNotFoundError();

    const remoteBase = normalizeBase(this.app.vault.getName());

    const nextcloudClient = new NextcloudClient(this.settings, this.appPassword, remoteBase, this.diag);
    let features: NextcloudFeatures;

    try {
      features = await nextcloudClient.connect();
    } catch (err) {
      // Maintenance is a server state, not a verdict on its type; swallowing it would show a bare "HTTP 503".
      if (err instanceof MaintenanceModeError) throw err;
      // No response at all is a transport failure, not evidence of plain WebDAV: retry with the standard client.
      const stdClient = new StandardWebDAVClient(this.settings, this.appPassword, remoteBase);
      features = await stdClient.connect();
      return { client: stdClient, features };
    }

    // The probes answered and it is not Nextcloud: degrade to plain WebDAV (Depth: 1 walk, since many servers refuse Depth: infinity).
    if (!features.isNextcloud) {
      const stdClient = new StandardWebDAVClient(this.settings, this.appPassword, remoteBase);
      return { client: stdClient, features: await stdClient.connect() };
    }

    // Older Nextcloud versions are not blocked; features degrade through capability detection.
    return { client: nextcloudClient, features };
  }
}
