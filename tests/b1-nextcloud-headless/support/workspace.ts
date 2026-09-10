// Sets up an isolated live workspace for a test file: connect, create the unique
// remote base folder (so the first upload doesn't 404 on missing ancestors), and
// hand back the client + workspace. Pair with cleanupWorkspace in afterAll.
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

/**
 * MKCOL the ancestors of `remoteFilePath`, tolerating the lock contention that only this harness
 * creates.
 *
 * Every test file gets its own unique `e2e-*` folder, but they all sit under ONE shared root
 * (SYNC_FOLDER), and jest runs the files in a dozen separate PROCESSES. On the first run against a
 * freshly provisioned server that root does not exist yet, so a dozen processes MKCOL it in the same
 * second and Nextcloud — which locks a collection while creating it — answers all but one with 423
 * Locked. The plugin's own single-flight cache cannot help here: it dedupes within one client, and
 * these are separate OS processes.
 *
 * A bounded retry is the right tool rather than a workaround: the 423 is transient by construction
 * (the winner's MKCOL finishes in milliseconds and the loser then gets a 405), and no amount of
 * in-process coordination can dedupe across processes. Every later run sees the root already there
 * and never enters this path.
 *
 * Before feature 088 this was invisible because `ensureRemoteDir` swallowed every failed MKCOL; it
 * now reports them, which is what surfaced the race.
 */
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
  await mkcolAncestors(env, `${ws.remoteBase}/_init.md`);
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
  await mkcolAncestors(env, `${ws.remoteBase}/${relPath}`);
}
