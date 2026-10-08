// Layer A — connection / auth (CN-1..CN-5). Live Nextcloud; skips when env is absent.
// This server returns 415 for sync-collection REPORT (the nginx layer rejects it) while PROPFIND works (207), so
// getSyncToken yields null and the engine degrades to full-scan; CN-5 asserts graceful degradation and the
// REPORT-dependent TK cases are skipped.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { describeLive } from '../support/env';
import { makeSettings } from '../support/clientFactory';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';

describeLive('Layer A — connection/auth (CN)', (getEnv) => {
  let ws: IsolatedWorkspace;
  let client: NextcloudClient;

  beforeAll(async () => {
    const s = await setupWorkspace(getEnv());
    ws = s.ws;
    client = s.client;
  });

  afterAll(async () => {
    if (client && ws) await cleanupWorkspace(client, ws);
  });

  it('[SPEC:CN-1] connects and reports Nextcloud capabilities', async () => {
    const features = await client.connect();
    expect(features.isNextcloud).toBe(true);
    expect(typeof features.version).toBe('string');
  });

  it('[SPEC:CN-2] auth failure yields NetworkError(401)', async () => {
    const env = getEnv();
    const bad = new NextcloudClient(makeSettings(env), 'definitely-wrong-password', ws.remoteBase);
    await expect(bad.getFiles('')).rejects.toMatchObject({ status: 401 });
  });

  // CN-3: maintenance mode. Skipped — cannot toggle server maintenance from a test.
  // Would assert connect() throws MaintenanceModeError when /status.php reports maintenance:true.
  it.skip('CN-3 maintenance mode throws MaintenanceModeError (needs server control)', () => undefined);

  it('[SPEC:CN-4] unreachable host rejects', async () => {
    const env = getEnv();
    const badUrl = env.serverUrl.replace(/^https?:\/\/[^/]+/, 'https://nonexistent.invalid');
    const c = new NextcloudClient(makeSettings(env, { serverUrl: badUrl }), env.appPassword, ws.remoteBase);
    await expect(c.connect()).rejects.toBeDefined();
  });

  it('[SPEC:CN-5] getSyncToken degrades gracefully (token or null, no throw)', async () => {
    // getSyncToken returns null (415 on REPORT); assert it does not throw.
    const token = await client.getSyncToken();
    expect(token === null || typeof token === 'string').toBe(true);
  });
});
