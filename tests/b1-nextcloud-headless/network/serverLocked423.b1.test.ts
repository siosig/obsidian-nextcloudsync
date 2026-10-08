// Server-side lock detection on 423 (issue #58).
// SL-1: the admin locks a file and shares it with ncuser2, whose client then PUTs and DELETEs the shared file; both must
// surface as ServerLockedError (a lock held by a DIFFERENT identity). The a-layer serverLock423 suites cover the
// client-side 423 -> ServerLockedError logic with a mocked response.
// SL-2: only a real server can prove a genuine lockdiscovery PROPFIND round-trip is well-formed (207, readable,
// readLockDiscoveryOwner never throws) and that an owner, if reported, is extracted.
// It does NOT assert an owner is always present: on the Docker suite's Nextcloud a lock taken via
// NextcloudClient.lockFile (X-User-Lock: '1') answers 207 with no owner in <D:lockdiscovery>, whereas issue #58's
// server showed the Text editor as owner. Whether an owner is exposed depends on server version and on who took the
// lock, which this harness cannot control; hence FR-004's fallback to the plain message when no owner can be read.
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
  it('[SPEC:SL-1] 423-on-PUT/DELETE from a foreign lock holder', async () => {
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

  it('[SPEC:SL-2] lockdiscovery PROPFIND round-trip against a real server', async () => {
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
