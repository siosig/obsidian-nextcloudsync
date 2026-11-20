import { App } from 'obsidian';
import { AppPasswordReader, DavSyncSettings, NextcloudFeatures } from '../types';
import { IWebDAVClient } from './IWebDAVClient';
import { NextcloudClient } from './NextcloudClient';
import { StandardWebDAVClient } from './StandardWebDAVClient';
import { CredentialsNotFoundError, MaintenanceModeError } from '../types';
import { normalizeBase } from './remotePath';

export class WebDAVFactory {
  constructor(
    private readonly app: App,
    private readonly settings: DavSyncSettings,
    private readonly readAppPassword: AppPasswordReader,
    private readonly diag?: (msg: string) => void,
  ) {}

  async createClient(): Promise<{ client: IWebDAVClient; features: NextcloudFeatures }> {
    if (!this.readAppPassword()) throw new CredentialsNotFoundError();

    const remoteBase = normalizeBase(this.app.vault.getName());

    const nextcloudClient = new NextcloudClient(this.settings, this.readAppPassword, remoteBase, this.diag);
    let features: NextcloudFeatures;

    try {
      features = await nextcloudClient.connect();
    } catch (err) {
      // Maintenance is a server state and a missing app password is a local state; neither is a verdict on the server type.
      if (err instanceof MaintenanceModeError || err instanceof CredentialsNotFoundError) throw err;
      // No response at all is a transport failure, not evidence of plain WebDAV: retry with the standard client.
      const stdClient = new StandardWebDAVClient(this.settings, this.readAppPassword, remoteBase);
      features = await stdClient.connect();
      return { client: stdClient, features };
    }

    // The probes answered and it is not Nextcloud: degrade to plain WebDAV (Depth: 1 walk, since many servers refuse Depth: infinity).
    if (!features.isNextcloud) {
      const stdClient = new StandardWebDAVClient(this.settings, this.readAppPassword, remoteBase);
      return { client: stdClient, features: await stdClient.connect() };
    }

    // Older Nextcloud versions are not blocked; features degrade through capability detection.
    return { client: nextcloudClient, features };
  }
}
