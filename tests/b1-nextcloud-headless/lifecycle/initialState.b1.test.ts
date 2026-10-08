// Layer A — initial state: the sync target (vault folder) does not exist on the server yet (first-ever sync).
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { describeLive } from '../support/env';
import { makeClient } from '../support/clientFactory';
import { makeIsolatedWorkspace, cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { textBuf, decodeBuf } from '../support/helpers';
import { RemoteRootMissingError } from '../../../src/types';

describeLive('Layer A — initial state (no vault folder on server yet)', (getEnv) => {
  let ws: IsolatedWorkspace;
  let client: NextcloudClient;

  beforeAll(() => {
    const env = getEnv();
    // A fresh unique workspace intentionally NOT created on the server, emulating
    // the first sync where the vault folder does not exist yet.
    ws = makeIsolatedWorkspace(env.syncFolder);
    client = makeClient(env, ws.remoteBase);
  });

  afterAll(async () => {
    if (client && ws) await cleanupWorkspace(client, ws);
  });

  it('[SPEC:INIT-1] connect succeeds even though the vault folder does not exist', async () => {
    const features = await client.connect();
    expect(features.isNextcloud).toBe(true);
  });

  it('[SPEC:INIT-2] getFiles on a non-existent vault folder reports it as missing, not as empty', async () => {
    // A 404 on the vault root used to be flattened into an empty listing, which the full scan read as every tracked file
    // deleted (issue #50). The client now says which it is and the engine re-creates a missing folder, never deleting.
    await expect(client.getFiles('')).rejects.toThrow(RemoteRootMissingError);
  });

  it('[SPEC:INIT-3] first upload into a fresh vault creates the folder and the file', async () => {
    // First-ever upload into a fresh vault: the reactive MKCOL handles the 404 missing-parent (no pre-creation).
    await client.uploadFile('first-note.md', textBuf('first sync'));
    expect(decodeBuf(await client.downloadFile('first-note.md'))).toBe('first sync');
    const files = await client.getFiles('');
    expect(files.some((f) => f.path.endsWith('first-note.md'))).toBe(true);
  });
});
