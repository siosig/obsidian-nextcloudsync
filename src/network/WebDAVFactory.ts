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
    } catch (err) {
      // Maintenance is a Nextcloud state, not a verdict about the server's type. Swallowing it here
      // used to hide a temporary condition behind a permanent-looking capability loss (and, since the
      // DAV endpoint answers 503 during maintenance, the user got "HTTP 503 (PROPFIND)" instead of
      // being told the server is down for maintenance at all).
      if (err instanceof MaintenanceModeError) throw err;
      // Anything else reaching here is a transport failure: connect() suppresses HTTP statuses, so no
      // response at all is the only way out. That is NOT evidence of a plain-WebDAV server — it is the
      // absence of evidence — so it is handled as resilience, not as detection. Retrying against the
      // standard client preserves the case where the probes time out but the DAV endpoint is healthy.
      const stdClient = new StandardWebDAVClient(this.settings, this.appPassword, remoteBase);
      features = await stdClient.connect();
      return { client: stdClient, features };
    }

    // Detection proper: the probes answered, and what they said is that this is not a Nextcloud. Honour
    // the README's promise and degrade to plain WebDAV — which also matters beyond the feature flags,
    // because StandardWebDAVClient walks the tree with Depth: 1 precisely because many WebDAV servers
    // refuse Depth: infinity, and that is the code path such a server needs.
    if (!features.isNextcloud) {
      const stdClient = new StandardWebDAVClient(this.settings, this.appPassword, remoteBase);
      return { client: stdClient, features: await stdClient.connect() };
    }

    // Older Nextcloud servers are no longer hard-blocked here. The version is surfaced to
    // the caller (and recorded for the settings-screen recommendation banner); features
    // still degrade gracefully via capability detection.
    return { client: nextcloudClient, features };
  }
}
