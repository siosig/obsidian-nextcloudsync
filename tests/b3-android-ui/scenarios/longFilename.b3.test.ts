// [SPEC:AND-2] Atomic writes must stay inside the platform's NAME_MAX on a real Android filesystem.
// A near-255-byte note failed with FILE_NOTCREATED because the atomic write's temp name exceeded the limit.
// Only the Android filesystem enforces this, so desktop layers cannot reproduce it.
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

  // Empirical boundary: the final name fit but the old temp suffix (+18 bytes) did not; at or above 237 reproduces it.
  const BOUNDARY_BYTES = 237;

  // NAME_MAX is 255 but the server rejects names above 250 bytes (HTTP 400), so the upper case stops there.
  const SERVER_MAX_BYTES = 250;

  for (const bytes of [BOUNDARY_BYTES, SERVER_MAX_BYTES]) {
    it(`writes and syncs a ${bytes}-byte filename without hitting NAME_MAX`, async function () {
      const name = filenameOfByteLength(bytes, `-${stamp}.md`.slice(-12));
      const content = `long name ${bytes}\n`;
      created.push(name);

      // Server-first, so the download path performs the atomic write (and creates a temp file) on the device.
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

      // A failed atomic write must not strand a temp file.
      const strays = await browser.executeObsidian(async ({ app }) => {
        const listing = await app.vault.adapter.list('');
        return listing.files.filter((f: string) => /\.tmp$|~$/.test(f));
      });
      expect(strays).toEqual([]);
    });
  }
});
