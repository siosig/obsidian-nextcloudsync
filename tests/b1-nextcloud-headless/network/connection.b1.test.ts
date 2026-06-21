// Layer A — connection / auth (CN-1..CN-5) per report/mock_test.md §3.A.
// Runs against a live Nextcloud server; skips when env is absent.
//
// IMPORTANT (live finding): this server returns HTTP 415 for sync-collection
// REPORT (the nginx layer in front of Nextcloud rejects the REPORT method),
// while PROPFIND works (207). getSyncToken therefore yields null and the engine
// degrades to full-scan sync. CN-5 asserts graceful degradation rather than a
// non-empty token, and the REPORT-dependent TK cases are skipped with a reason.
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

  it('CN-1 connects and reports Nextcloud capabilities', async () => {
    const features = await client.connect();
    expect(features.isNextcloud).toBe(true);
    expect(typeof features.version).toBe('string');
  });

  it('CN-2 auth failure yields NetworkError(401)', async () => {
    const env = getEnv();
    const bad = new NextcloudClient(makeSettings(env), 'definitely-wrong-password', ws.remoteBase);
    await expect(bad.getFiles('')).rejects.toMatchObject({ status: 401 });
  });

  // CN-3: maintenance mode. Skipped — cannot toggle server maintenance from a test.
  // Would assert connect() throws MaintenanceModeError when /status.php reports maintenance:true.
  it.skip('CN-3 maintenance mode throws MaintenanceModeError (needs server control)', () => undefined);

  it('CN-4 unreachable host rejects', async () => {
    const env = getEnv();
    const badUrl = env.serverUrl.replace(/^https?:\/\/[^/]+/, 'https://nonexistent.invalid');
    const c = new NextcloudClient(makeSettings(env, { serverUrl: badUrl }), env.appPassword, ws.remoteBase);
    await expect(c.connect()).rejects.toBeDefined();
  });

  it('CN-5 getSyncToken degrades gracefully (token or null, no throw)', async () => {
    // This server 415s sync-collection REPORT, so getSyncToken returns null and
    // the engine falls back to full-scan. Assert it does not throw.
    const token = await client.getSyncToken();
    expect(token === null || typeof token === 'string').toBe(true);
  });
});
