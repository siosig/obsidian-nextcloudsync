// Layer B — deletion safety (SF) per report/mock_test.md §3.H.
// The full-scan deletion reconciliation and the mass-delete circuit breaker live
// inside SyncEngine.syncManual, whose harness (fakeVault + LocalAdapter + StateDB +
// WebDAVFactory) is out of scope for this feature (see spec FR-016 / Layer B decision).
// We verify the live remote-state transition that those features build on, and keep
// the engine-level cases as skip-with-reason.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { describeLive } from '../support/env';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';
import { textBuf } from '../support/helpers';

describeLive('Layer B — deletion safety (SF)', (getEnv) => {
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

  it('SF live remote-state: a remote delete is reflected in the listing', async () => {
    await client.uploadFile('sf-a.md', textBuf('a'));
    await client.uploadFile('sf-b.md', textBuf('b'));
    let files = await client.getFiles('');
    const before = files.filter((f) => f.path.startsWith('sf-')).map((f) => f.path);
    expect(before.some((p) => p.endsWith('sf-a.md'))).toBe(true);
    expect(before.some((p) => p.endsWith('sf-b.md'))).toBe(true);

    await client.deleteFile('sf-a.md', '');
    files = await client.getFiles('');
    const after = files.map((f) => f.path);
    expect(after.some((p) => p.endsWith('sf-a.md'))).toBe(false);
    expect(after.some((p) => p.endsWith('sf-b.md'))).toBe(true);
  });

  // SF-1..4: full-scan deletion propagation, lost-update prevention, checksum-less
  // delete, and the mass-delete circuit breaker (max(20, 20% of tracked)) require
  // driving SyncEngine.syncManual with a fake vault. Out of scope for this feature.
  it.skip('SF-1..4 full-scan deletion safety & mass-delete circuit breaker (needs SyncEngine harness)', () => undefined);
});
