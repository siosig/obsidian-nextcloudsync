// [SPEC:ES-1][SPEC:ES-6] Root-ETag short-circuit (spec 023) — live verification of the core premise
// the optimization relies on: Nextcloud propagates ANY descendant change up to the vault root
// collection's ETag, and the ETag is stable while nothing changes. If this held false on the real
// server, the short-circuit could miss remote changes — so it is verified here against live Nextcloud.
//
// Manual only (pnpm test:b1 -- rootEtagShortcircuit); skips cleanly without .env NEXTCLOUD_*.
import { describeLive } from '../support/env';
import { makeClient, baseUrlOf, authHeaderOf } from '../support/clientFactory';
import { requestUrl } from 'obsidian';

function enc(s: string): ArrayBuffer { return new TextEncoder().encode(s).buffer as ArrayBuffer; }

describeLive('PERF/SAFETY: root-ETag propagation (spec 023)', (getEnv) => {
  const env = getEnv();
  const runFolder = `etag-sc-${Date.now()}`;
  const remoteBase = env.syncFolder ? `${env.syncFolder}/${runFolder}` : runFolder;

  function collUrl(): string {
    return `${baseUrlOf(env)}/${remoteBase.split('/').filter(Boolean).map(encodeURIComponent).join('/')}/`;
  }

  afterAll(async () => {
    await requestUrl({ url: collUrl(), method: 'DELETE', headers: { Authorization: authHeaderOf(env) }, throw: false }).catch(() => undefined);
  }, 60_000);

  it('root ETag is non-null, stable while unchanged, and changes on a descendant write', async () => {
    const client = makeClient(env, remoteBase);
    await client.connect();
    await client.uploadFile('a/note.md', enc('# a\n'));

    // ES-1: a real, non-null root ETag is obtainable.
    const e1 = await client.getRootEtag();
    expect(e1).not.toBeNull();

    // Stable: a second read with no change returns the same value (⇒ short-circuit would trigger).
    const e1b = await client.getRootEtag();
    expect(e1b).toBe(e1);

    // ES-6: a descendant write (even in a nested subdir) changes the root ETag (⇒ next sync real-scans).
    await client.uploadFile('a/deep/changed.md', enc(`# changed ${Date.now()}\n`));
    const e2 = await client.getRootEtag();
    expect(e2).not.toBeNull();
    expect(e2).not.toBe(e1);
  }, 120_000);
});
