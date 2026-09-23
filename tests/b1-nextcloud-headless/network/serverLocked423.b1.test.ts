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
// PROPFIND round-trip is well-formed (207, readable, readLockDiscoveryOwner never throws), and that
// IF the server reports an owner, the reader extracts it correctly.
//
// It does NOT assert that an owner is always present. Measured against this project's own
// nextcloud-testinstance: taking a lock via NextcloudClient.lockFile (X-User-Lock: '1', the plugin's
// own mechanism) and then issuing the exact PROPFIND from contracts/lockdiscovery-propfind.md comes
// back 207 but with NO owner in <D:lockdiscovery> (neither D:owner nor nc:lock-owner). This differs
// from issue #58's own report, where a lock held by the Nextcloud Text web editor on the reporter's
// server (35.0.0) DID show `<d:owner>Text</d:owner>`/`<nc:lock-owner>Text</nc:lock-owner>` under the
// same query. Whether files_lock exposes an owner via plain lockdiscovery apparently depends on the
// server version and/or on WHO/WHAT took the lock (X-User-Lock via this plugin's own lockFile vs. the
// Text app's own lock-taking path) — not something this harness can control or force either way.
// This is exactly why FR-004 requires a graceful fallback to the plain, pre-existing message when no
// owner can be read: production correctness does not depend on the owner always being present.
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
      // Never throws (contract's read rules): returns the owner when the server reports one, or
      // null when it does not. Both are valid outcomes against a real server (see file header) — the
      // property under test is that this real response is READABLE, not that an owner is guaranteed.
      let owner: string | null = null;
      expect(() => { owner = readLockDiscoveryOwner(text); }).not.toThrow();
      if (owner === null) {
        // Logged (not failed) so a real owner-bearing server would show up in test output for
        // comparison, without making this test flaky against servers/lock-holders that never expose one.
        console.warn(`[e2e] SL-2: server reported no lockdiscovery owner for a lock this test itself took (see file header). Raw body: ${text.slice(0, 500)}`);
      } else {
        expect(typeof owner).toBe('string');
        expect(owner).not.toBe('');
      }
    } finally {
      await client.unlockFile(relPath, token);
    }
  });
});
