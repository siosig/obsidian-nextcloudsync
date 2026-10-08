// [SPEC:AND-3] Paths and bodies must survive a round trip through the mobile HTTP implementation.
// Two shipped bugs in Android's Capacitor `requestUrl` (desktop uses Electron's net stack): paths with a space
// were encoded twice (404), and a downloaded body's byteLength differed from content-length (rejected as corrupt).
// Assertions compare BYTES, never decoded strings, which would hide a length mismatch.
import { browser, expect } from '@wdio/globals';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';
import { seedConnection } from '../support/plugin';
import { RemoteProbe } from '../support/webdav';

const env = requireAndroidEnv();
const stamp = `b3-path-${process.pid}`;

// Names that have historically broken encoding. `name` is what the test PUTs; `arrivesAs` is what the vault must
// end up with. They differ only for the combining diacritic: Nextcloud stores names in NFC, so a decomposed
// `e` + U+0301 comes back as U+00E9.
const TRICKY_NAMES = [
  { label: 'ASCII space', name: `${stamp} with space.md` },
  { label: 'Japanese', name: `${stamp}-\u30e1\u30e2.md` },
  { label: 'Japanese with space', name: `${stamp}-\u4f1a\u8b70 \u30e1\u30e2.md` },
  { label: 'percent literal', name: `${stamp}-100%done.md` },
  { label: 'plus sign', name: `${stamp}-a+b.md` },
  { label: 'combining diacritic', name: `${stamp}-cafe\u0301.md` },
].map((n) => ({ ...n, arrivesAs: n.name.normalize('NFC') }));

describe('[SPEC:AND-3] b-3 — path and body round trip through the mobile HTTP stack', function () {
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

  for (const { label, name, arrivesAs } of TRICKY_NAMES) {
    it(`downloads a remote note whose name contains ${label}`, async function () {
      const content = `remote ${label}\n`;
      created.push(name);

      const put = await probe!.put(name, content);
      expect([201, 204]).toContain(put.status);

      await browser.executeObsidianCommand('nextcloud-sync:sync-now');

      const local = await browser.waitUntil(
        async () => {
          const got = await browser.executeObsidian(
            async ({ app }, path: string) =>
              (await app.vault.adapter.exists(path)) ? app.vault.adapter.read(path) : null,
            arrivesAs,
          );
          return got as string | null;
        },
        {
          timeout: 120_000,
          interval: 3_000,
          timeoutMsg: `"${arrivesAs}" never arrived — a 404 here means the path was encoded twice`,
        },
      );
      expect(local).toBe(content);
    });
  }

  it('uploads a binary attachment without altering a single byte', async function () {
    // Every byte value 0..255, so any transcoding or truncation shows up.
    const name = `${stamp}-\u30d0\u30a4\u30ca\u30ea \u6dfb\u4ed8.bin`;
    created.push(name);
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

    await browser.executeObsidian(
      async ({ app }, path: string, b64: string) => {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        await app.vault.adapter.writeBinary(path, buf.buffer);
      },
      name,
      bytes.toString('base64'),
    );

    await browser.executeObsidianCommand('nextcloud-sync:sync-now');
    await browser.waitUntil(async () => (await probe!.get(name)).status === 200, {
      timeout: 120_000,
      interval: 3_000,
      timeoutMsg: `"${name}" never reached the server`,
    });

    const remote = await probe!.get(name);
    expect(remote.body.length).toBe(bytes.length);
    expect(remote.body.equals(bytes)).toBe(true);
  });
});
