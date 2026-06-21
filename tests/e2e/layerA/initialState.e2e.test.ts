// Layer A — initial state: the sync target (vault folder) does not exist on the
// server yet (first-ever sync). Per the user's request to cover the no-vault case.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { describeLive } from '../support/env';
import { makeClient } from '../support/clientFactory';
import { makeIsolatedWorkspace, cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { textBuf, decodeBuf } from '../support/helpers';

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

  it('INIT-1 connect succeeds even though the vault folder does not exist', async () => {
    const features = await client.connect();
    expect(features.isNextcloud).toBe(true);
  });

  it('INIT-2 getFiles on a non-existent vault folder returns [] (404 → empty)', async () => {
    const files = await client.getFiles('');
    expect(files).toEqual([]);
  });

  it('INIT-3 first upload into a fresh vault creates the folder and the file', async () => {
    // First-ever upload into a fresh vault: reactive MKCOL now handles the 404 missing-parent
    // (no pre-creation), the file round-trips, and the once-empty vault lists it.
    await client.uploadFile('first-note.md', textBuf('first sync'));
    expect(decodeBuf(await client.downloadFile('first-note.md'))).toBe('first sync');
    const files = await client.getFiles('');
    expect(files.some((f) => f.path.endsWith('first-note.md'))).toBe(true);
  });
});
