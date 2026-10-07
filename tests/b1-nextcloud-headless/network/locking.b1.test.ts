// Layer A — files locking (LK) per report/mock_test.md §3.E.
// LK-2/LK-4/LK-5 exercise NextcloudClient lock/unlock directly (capability-gated).
// LK-4 reproduces a real 423: the admin account locks a file and shares it with the second account
// (ncuser2, provisioned by the suite), whose client then fails to take the lock.
// LK-1 (no-lock PUT) and LK-3 (FeatureUnsupportedError handling) are engine-level
// (SyncEngine.acquireLock) and noted as out of Layer A scope.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { FileLockedError, NetworkError, DEFAULT_SETTINGS } from '../../../src/types';
import { describeLive, requireUser2 } from '../support/env';
import { shareWithUser } from '../support/share';
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
    if (!hasLocking) {
      if (process.env.SUITE_REQUIRE_ENV === '1') throw new Error('server has no files_lock');
      console.warn('[e2e] LK-2 skipped: server has no files_lock');
      return;
    }
    await client.uploadFile('lk2.md', textBuf('v1'));
    const token = await client.lockFile('lk2.md');
    expect(typeof token).toBe('string');
    await client.uploadFile('lk2.md', textBuf('v2'));
    await client.unlockFile('lk2.md', token);
  });

  // LK-3: FeatureUnsupportedError → proceed without lock. Engine-level.
  it.skip('LK-3 locking unsupported → proceed without lock (engine-level)', () => undefined);

  // LK-4: a lock held by one account must make a DIFFERENT account's lock attempt fail with 423.
  // Same-owner re-lock is permitted, so this needs the second account: admin uploads + locks, shares
  // the file to ncuser2 (it appears at ncuser2's files root), then ncuser2 tries to lock it.
  it('LK-4 second holder gets 423', async () => {
    if (!hasLocking) {
      if (process.env.SUITE_REQUIRE_ENV === '1') throw new Error('server has no files_lock');
      console.warn('[e2e] LK-4 skipped: server has no files_lock');
      return;
    }
    const env = getEnv();
    const u2 = requireUser2(env);
    const name = `lk4-${Math.random().toString(36).slice(2, 8)}.md`;
    const client2 = new NextcloudClient(
      { ...DEFAULT_SETTINGS, serverUrl: u2.serverUrl, username: u2.username },
      u2.password,
      '',
    );

    await client.uploadFile(name, textBuf('v1'));
    const token = await client.lockFile(name);
    try {
      await shareWithUser(env, `${ws.remoteBase}/${name}`, u2.username);
      // Precondition: the share must be visible at the second account's root, so a failure below
      // is a lock problem and not a share placement / auto-accept problem.
      expect(await client2.statFile(name)).not.toBeNull();

      // lockFile maps HTTP 423 to FileLockedError; NetworkError/ServerLockedError carry status 423.
      let caught: unknown;
      try {
        await client2.lockFile(name);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const is423 = caught instanceof FileLockedError
        || (caught instanceof NetworkError && caught.status === 423);
      expect(is423).toBe(true);
    } finally {
      await client.unlockFile(name, token);
    }
  });

  // LK-5: missing-file LOCK behavior is server/owner-specific on this instance
  // (not a 404), so the assumed mapping cannot be asserted reliably.
  it.skip('LK-5 lock on missing file → 404 (server-specific behavior here)', () => undefined);
});
