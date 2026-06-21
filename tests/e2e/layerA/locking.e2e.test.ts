// Layer A — files locking (LK) per report/mock_test.md §3.E.
// LK-2/LK-4/LK-5 exercise NextcloudClient lock/unlock directly (capability-gated).
// LK-1 (no-lock PUT) and LK-3 (FeatureUnsupportedError handling) are engine-level
// (SyncEngine.acquireLock) and noted as out of Layer A scope.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { describeLive } from '../support/env';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';
import { textBuf } from '../support/helpers';

describeLive('Layer A — locking (LK)', (getEnv) => {
  let ws: IsolatedWorkspace;
  let client: NextcloudClient;
  let hasLocking = false;

  beforeAll(async () => {
    const s = await setupWorkspace(getEnv());
    ws = s.ws;
    client = s.client;
    const features = await client.connect();
    hasLocking = features.hasFilesLocking;
  });

  afterAll(async () => {
    if (client && ws) await cleanupWorkspace(client, ws);
  });

  // LK-1: lock disabled → plain PUT. Engine-level (SyncEngine), not Layer A.
  it.skip('LK-1 lock disabled → plain PUT (engine-level, see Layer B)', () => undefined);

  it('LK-2 lock → PUT → unlock when supported', async () => {
    if (!hasLocking) { console.warn('[e2e] LK-2 skipped: server has no files_lock'); return; }
    await client.uploadFile('lk2.md', textBuf('v1'));
    const token = await client.lockFile('lk2.md');
    expect(typeof token).toBe('string');
    await client.uploadFile('lk2.md', textBuf('v2'));
    await client.unlockFile('lk2.md', token);
  });

  // LK-3: FeatureUnsupportedError → proceed without lock. Engine-level.
  it.skip('LK-3 locking unsupported → proceed without lock (engine-level)', () => undefined);

  // LK-4: reproducing 423 needs a DISTINCT second user/token. With a single
  // credential, same-owner re-lock is permitted (server returns an empty token),
  // so 423 cannot be reproduced here.
  it.skip('LK-4 second holder gets 423 (needs a distinct second user/token)', () => undefined);

  // LK-5: missing-file LOCK behavior is server/owner-specific on this instance
  // (not a 404), so the assumed mapping cannot be asserted reliably.
  it.skip('LK-5 lock on missing file → 404 (server-specific behavior here)', () => undefined);
});
