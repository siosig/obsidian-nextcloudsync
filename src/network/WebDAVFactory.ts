import { App } from 'obsidian';
import { DavSyncSettings, NextcloudFeatures } from '../types';
import { IWebDAVClient } from './IWebDAVClient';
import { NextcloudClient } from './NextcloudClient';
import { StandardWebDAVClient } from './StandardWebDAVClient';
import { CredentialsNotFoundError } from '../types';
import { normalizeBase } from './remotePath';

export class WebDAVFactory {
  constructor(
    private readonly app: App,
    private readonly settings: DavSyncSettings,
    private readonly appPassword: string | null,
    /** Optional diagnostic sink (Debug-mode file log) passed down to the Nextcloud client. */
    private readonly diag?: (msg: string) => void,
  ) {}

  async createClient(): Promise<{ client: IWebDAVClient; features: NextcloudFeatures }> {
    if (!this.appPassword) throw new CredentialsNotFoundError();

    // Fix the remote sync target's base folder to the Vault name (isolating each Vault on the server).
    const remoteBase = normalizeBase(this.app.vault.getName());

    const nextcloudClient = new NextcloudClient(this.settings, this.appPassword, remoteBase, this.diag);
    let features: NextcloudFeatures;

    try {
      features = await nextcloudClient.connect();
    } catch {
      // Not Nextcloud or connection failed: try standard WebDAV
      const stdClient = new StandardWebDAVClient(this.settings, this.appPassword, remoteBase);
      features = await stdClient.connect();
      return { client: stdClient, features };
    }

    // Older Nextcloud servers are no longer hard-blocked here. The version is surfaced to
    // the caller (and recorded for the settings-screen recommendation banner); features
    // still degrade gracefully via capability detection.
    return { client: nextcloudClient, features };
  }
}
