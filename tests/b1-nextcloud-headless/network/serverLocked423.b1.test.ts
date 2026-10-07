// Feature 090 (issue #58): server-side lock detection on 423.
//
// SL-1 reproduces a foreign-lock 423 against a real server: the admin account locks a file and
// shares it with a second account (ncuser2, now provisioned by the suite), and ncuser2's client then
// attempts a PUT and a DELETE on the shared file. Shared-file locking reproduces the 423, and both
// must surface as ServerLockedError (the very scenario issue #58 reports: a lock held by a DIFFERENT
// identity). The a-layer suites (tests/a-no-nextcloud/network/nextcloudClient.serverLock423.test.ts
// and standardWebDavClient.serverLock423.test.ts) additionally cover the client-side 423 ->
// ServerLockedError logic deterministically with a mocked 423 + lockdiscovery response.
//
// SL-2 verifies the one thing only a real server can prove: that a genuine Nextcloud lockdiscovery
// PROPFIND round-trip is well-formed (207, readable, readLockDiscoveryOwner never throws), and that
// IF the server reports an owner, the reader extracts it correctly.
//
// It does NOT assert that an owner is always present. Measured against this project's own Docker test suite
// Nextcloud: taking a lock via NextcloudClient.lockFile (X-User-Lock: '1', the plugin's
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
import { ServerLockedError, DEFAULT_SETTINGS } from '../../../src/types';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { describeLive, requireUser2 } from '../support/env';
import { shareWithUser } from '../support/share';
import { authHeaderOf, baseUrlOf } from '../support/clientFactory';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace, LiveWorkspace } from '../support/workspace';
import { textBuf } from '../support/helpers';
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

  // SL-1: a lock held by another account makes PUT and DELETE fail with ServerLockedError.
  it('SL-1 423-on-PUT/DELETE from a foreign lock holder', async () => {
    if (!hasLocking) {
      if (process.env.SUITE_REQUIRE_ENV === '1') throw new Error('server has no files_lock');
      console.warn('[e2e] SL-1 skipped: server has no files_lock');
      return;
    }
    const u2 = requireUser2(env);
    const name = `sl1-${Math.random().toString(36).slice(2, 8)}.md`;
    const client2 = new NextcloudClient(
      { ...DEFAULT_SETTINGS, serverUrl: u2.serverUrl, username: u2.username },
      u2.password,
      '',
    );

    await client.uploadFile(name, textBuf('v1'));
    const token = await client.lockFile(name);
    try {
      await shareWithUser(env, `${ws.remoteBase}/${name}`, u2.username);
      // Precondition: the share is visible at the second account's root (see LK-4).
      expect(await client2.statFile(name)).not.toBeNull();

      await expect(client2.uploadFile(name, textBuf('v2'))).rejects.toBeInstanceOf(ServerLockedError);
      await expect(client2.deleteFile(name, '')).rejects.toBeInstanceOf(ServerLockedError);
    } finally {
      await client.unlockFile(name, token);
    }
  });

  it('SL-2 lockdiscovery PROPFIND round-trip against a real server', async () => {
    if (!hasLocking) {
      if (process.env.SUITE_REQUIRE_ENV === '1') throw new Error('server has no files_lock');
      console.warn('[e2e] SL-2 skipped: server has no files_lock');
      return;
    }

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
