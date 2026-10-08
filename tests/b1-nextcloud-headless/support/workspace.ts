// Isolated live workspace per test file: connect and create the unique remote base folder so the first upload does
// not 404 on missing ancestors. Pair with cleanupWorkspace in afterAll.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { ensureRemoteDir } from '../../../src/network/remotePath';
import { RemoteDirCache } from '../../../src/network/RemoteDirCache';
import { DavSyncSettings, RemoteDirCreateError } from '../../../src/types';
import { LiveEnv } from './env';
import { makeClient, baseUrlOf, authHeaderOf } from './clientFactory';
import { makeIsolatedWorkspace, IsolatedWorkspace } from './isolation';

export interface LiveWorkspace {
  ws: IsolatedWorkspace;
  client: NextcloudClient;
}

// MKCOLs the ancestors of `remoteFilePath`, tolerating the 423 only this harness provokes: jest runs files in separate
// processes that all MKCOL the shared SYNC_FOLDER root in the same second on a fresh server, and Nextcloud locks a
// collection while creating it. The plugin's single-flight cache dedupes only within one client, and the 423 is
// transient (the loser then gets 405), so a bounded retry is right. Later runs never enter this path.
async function mkcolAncestors(env: LiveEnv, remoteFilePath: string): Promise<void> {
  const ctx = { baseUrl: baseUrlOf(env), authHeader: authHeaderOf(env) };
  for (let attempt = 0; ; attempt++) {
    try {
      await ensureRemoteDir(ctx, remoteFilePath, new RemoteDirCache());
      return;
    } catch (err) {
      if (attempt >= 4 || !(err instanceof RemoteDirCreateError)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

// `ensureRemoteDir` MKCOLs every ancestor of the run folder, which `uploadFile` alone would not do when the
// grandparent is missing (404).
export async function setupWorkspace(
  env: LiveEnv,
  overrides?: Partial<DavSyncSettings>,
): Promise<LiveWorkspace> {
  const ws = makeIsolatedWorkspace(env.syncFolder);
  const client = makeClient(env, ws.remoteBase, overrides);
  await client.connect();
  await mkcolAncestors(env, `${ws.remoteBase}/_init.md`);
  return { ws, client };
}

// This server returns 404 (not 409) for a PUT with missing ancestors, so the client's reactive MKCOL (fires only
// on 409) does not create them.
export async function ensureParentDirs(
  env: LiveEnv,
  ws: IsolatedWorkspace,
  relPath: string,
): Promise<void> {
  await mkcolAncestors(env, `${ws.remoteBase}/${relPath}`);
}
