// Feature 090 (issue #58): server-side lock detection on 423.
//
// SL-1 (423-on-PUT/DELETE from a foreign lock holder) cannot be reproduced by this harness: it uses
// a SINGLE Nextcloud account (see support/env.ts), and LK-2/LK-4 in ./locking.b1.test.ts already
// establish that this server permits a client to PUT over its own held lock (same owner is not
// blocked) — the very scenario issue #58 reports (a lock held by a DIFFERENT identity, e.g. the
// Nextcloud Text web editor) needs a second account/token this harness does not have. The client-side
// logic that turns a 423 into a ServerLockedError is fully covered, deterministically, by the a-layer
// suites (tests/a-no-nextcloud/network/nextcloudClient.serverLock423.test.ts and
// standardWebDavClient.serverLock423.test.ts), which mock the 423 + lockdiscovery response instead.
//
// SL-2 verifies the one thing only a real server can prove: that a genuine Nextcloud lockdiscovery
// PROPFIND response is shaped the way contracts/lockdiscovery-propfind.md assumes, and that
// readLockDiscoveryOwner (the pure reader used in production) extracts the owner from it correctly.
import { readLockDiscoveryOwner } from '../../../src/network/dav/propfind';
import { encodeRemoteUrl, toRemotePath } from '../../../src/network/remotePath';
import { describeLive } from '../support/env';
import { authHeaderOf, baseUrlOf } from '../support/clientFactory';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace, LiveWorkspace } from '../support/workspace';
import { textBuf } from '../support/helpers';
import type { NextcloudClient } from '../../../src/network/NextcloudClient';
import type { LiveEnv } from '../support/env';

const LOCKDISCOVERY_BODY =
  '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>';

describeLive('Layer A — server lock detection on 423 (SL, feature 090)', (getEnv) => {
  let env: LiveEnv;
  let ws: IsolatedWorkspace;
  let client: NextcloudClient;
  let hasLocking = false;

  beforeAll(async () => {
    env = getEnv();
    const s: LiveWorkspace = await setupWorkspace(env);
    ws = s.ws;
    client = s.client;
    const features = await client.connect();
    hasLocking = features.hasFilesLocking;
  });

  afterAll(async () => {
    if (client && ws) await cleanupWorkspace(client, ws);
  });

  // SL-1: reproducing a real foreign-lock 423 needs a distinct second account/token, which this
  // single-credential harness does not have (see file header and LK-4 in locking.b1.test.ts, the
  // same limitation for the plugin's own lockFile/unlockFile round trip).
  it.skip('SL-1 423-on-PUT/DELETE from a foreign lock holder (needs a second account/token)', () => undefined);

  it('SL-2 lockdiscovery PROPFIND round-trip against a real server', async () => {
    if (!hasLocking) { console.warn('[e2e] SL-2 skipped: server has no files_lock'); return; }

    const relPath = 'sl2.md';
    await client.uploadFile(relPath, textBuf('v1'));
    const token = await client.lockFile(relPath);
    expect(typeof token).toBe('string');

    try {
      // Mirrors NextcloudClient's own private `remoteUrl()`: encodeRemoteUrl(baseUrl, toRemotePath(remoteBase, rel)).
      const url = encodeRemoteUrl(baseUrlOf(env), toRemotePath(ws.remoteBase, relPath));
      const res = await fetch(url, {
        method: 'PROPFIND',
        headers: {
          Authorization: authHeaderOf(env),
          Depth: '0',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        body: LOCKDISCOVERY_BODY,
      });
      expect(res.status).toBe(207);
      const text = await res.text();
      // A genuine lock is held on this path (via the `token` obtained above), so a spec-compliant
      // server MUST report a non-empty owner for it via D:owner or nc:lock-owner (contract
      // "読み取り規則" steps 2-3). A null here means the assumed response shape does NOT match this
      // server version — exactly the regression this real-server test exists to catch (the a-layer
      // suites only prove the parser against XML we wrote ourselves, never against a real response).
      const owner = readLockDiscoveryOwner(text);
      expect(owner).toEqual(expect.any(String));
      expect(owner).not.toBe('');
    } finally {
      await client.unlockFile(relPath, token);
    }
  });
});
