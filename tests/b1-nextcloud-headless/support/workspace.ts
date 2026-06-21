// Sets up an isolated live workspace for a test file: connect, create the unique
// remote base folder (so the first upload doesn't 404 on missing ancestors), and
// hand back the client + workspace. Pair with cleanupWorkspace in afterAll.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { ensureRemoteDir } from '../../../src/network/remotePath';
import { DavSyncSettings } from '../../../src/types';
import { LiveEnv } from './env';
import { makeClient, baseUrlOf, authHeaderOf } from './clientFactory';
import { makeIsolatedWorkspace, IsolatedWorkspace } from './isolation';

export interface LiveWorkspace {
  ws: IsolatedWorkspace;
  client: NextcloudClient;
}

/**
 * Create the isolated folder and a connected client. `ensureRemoteDir` MKCOLs
 * every ancestor of the run folder (SYNC_FOLDER and the unique e2e-* subfolder),
 * which `uploadFile` alone would not do when the grandparent is missing (404).
 */
export async function setupWorkspace(
  env: LiveEnv,
  overrides?: Partial<DavSyncSettings>,
): Promise<LiveWorkspace> {
  const ws = makeIsolatedWorkspace(env.syncFolder);
  const client = makeClient(env, ws.remoteBase, overrides);
  await client.connect();
  await ensureRemoteDir(
    { baseUrl: baseUrlOf(env), authHeader: authHeaderOf(env) },
    `${ws.remoteBase}/_init.md`,
    new Set(),
  );
  return { ws, client };
}

/**
 * Pre-create the ancestor folders of a workspace-relative path. Needed because
 * this server returns 404 (not 409) for a PUT with missing ancestors, so the
 * client's reactive MKCOL (which only fires on 409) does not create them.
 */
export async function ensureParentDirs(
  env: LiveEnv,
  ws: IsolatedWorkspace,
  relPath: string,
): Promise<void> {
  await ensureRemoteDir(
    { baseUrl: baseUrlOf(env), authHeader: authHeaderOf(env) },
    `${ws.remoteBase}/${relPath}`,
    new Set(),
  );
}
