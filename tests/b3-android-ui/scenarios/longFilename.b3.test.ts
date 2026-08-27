// [SPEC:AND-2] Atomic writes must stay inside the platform's NAME_MAX on a real Android filesystem.
//
// Regression origin: a note whose final name was already close to the 255-byte limit failed to sync on
// Android with FILE_NOTCREATED. The final name fit; the temporary name the atomic write used did not,
// because the suffix pushed it over. The fix moved to a short hash-based temp name in the same
// directory.
//
// Why this cannot live in another layer: the limit is enforced by the Android filesystem itself. On
// the desktop layers the write simply succeeds, so the bug is invisible there — layer a can only
// assert the naming function in isolation, which is what let the real boundary slip through the first
// time.
import { browser, expect } from '@wdio/globals';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';
import { seedConnection } from '../support/plugin';
import { filenameOfByteLength } from '../support/android';
import { RemoteProbe } from '../support/webdav';

const env = requireAndroidEnv();
const stamp = `b3-len-${process.pid}`;

describe('[SPEC:AND-2] b-3 — long filenames survive the atomic write', function () {
  let probe: RemoteProbe | undefined;
  const created: string[] = [];

  before(async function () {
    requireEnvOrSkip(this);
    probe = await RemoteProbe.forCurrentVault();
    await seedConnection(env.values.NEXTCLOUD_SERVER_URL, env.values.NEXTCLOUD_USER, env.values.NEXTCLOUD_PASSWORD);
  });

  after(async function () {
    if (!probe) return;
    for (const p of created) await probe.removeQuietly(p);
  });

  // 237 bytes was the empirically established boundary for the original bug: the final name fit, and
  // the old temp suffix (+18 bytes) did not. Anything at or above it reproduces the failure.
  const BOUNDARY_BYTES = 237;

  // The platform's NAME_MAX is 255, but the SERVER refuses earlier: measured against the test
  // instance, 250 bytes is accepted and 251 is rejected with HTTP 400. Testing above that asserts
  // Nextcloud's own validator, not this plugin's temp-name handling, so the upper case sits at the
  // largest name the server can actually hold.
  const SERVER_MAX_BYTES = 250;

  for (const bytes of [BOUNDARY_BYTES, SERVER_MAX_BYTES]) {
    it(`writes and syncs a ${bytes}-byte filename without hitting NAME_MAX`, async function () {
      const name = filenameOfByteLength(bytes, `-${stamp}.md`.slice(-12));
      const content = `long name ${bytes}\n`;
      created.push(name);

      // Server-first, so the download path performs the atomic write on the device — that is the
      // direction that actually creates a temp file next to the target.
      const put = await probe!.put(name, content);
      expect([201, 204]).toContain(put.status);

      await browser.executeObsidianCommand('nextcloud-sync:sync-now');

      const local = await browser.waitUntil(
        async () => {
          const got = await browser.executeObsidian(
            async ({ app }, path: string) =>
              (await app.vault.adapter.exists(path)) ? app.vault.adapter.read(path) : null,
            name,
          );
          return got as string | null;
        },
        {
          timeout: 120_000,
          interval: 3_000,
          timeoutMsg: `a ${bytes}-byte filename never landed on the device — check for FILE_NOTCREATED`,
        },
      );
      expect(local).toBe(content);

      // No temp file may be left behind: a failed atomic write used to strand one.
      const strays = await browser.executeObsidian(async ({ app }) => {
        const listing = await app.vault.adapter.list('');
        return listing.files.filter((f: string) => /\.tmp$|~$/.test(f));
      });
      expect(strays).toEqual([]);
    });
  }
});
