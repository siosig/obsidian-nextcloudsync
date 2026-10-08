// b-3 smoke: the plugin runs on a real Android runtime and completes one sync round trip in each direction.
// The first two cases (plugin enabled, settings persist) are preconditions, not b-3 clauses; they make a failure
// point at the harness. The round-trip cases are b-3 clauses (AND-4): on Android the transfer goes through
// Capacitor's `requestUrl`, a different implementation from the Electron one b-2 exercises.
import { browser, expect } from '@wdio/globals';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';
import { seedConnection, pluginLogTail } from '../support/plugin';
import { RemoteProbe } from '../support/webdav';

const env = requireAndroidEnv();

// Unique per run so a crashed run never poisons the next one.
const stamp = `b3-smoke-${process.pid}`;

describe('b-3 smoke — plugin runs on a real Android runtime', function () {
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

  it('the Nextcloud Sync plugin is installed and enabled', async () => {
    const enabled = await browser.executeObsidian(
      ({ app }) => !!(app as any).plugins.enabledPlugins.has('nextcloud-sync'),
    );
    expect(enabled).toBe(true);
  });

  it('the plugin reports the Android runtime, not desktop', async () => {
    // Guards against the suite silently running on a desktop build; every b-3 clause assumes Capacitor.
    const platform = await browser.executeObsidian(({ obsidian }) => ({
      isAndroidApp: (obsidian as any).Platform.isAndroidApp,
      isDesktopApp: (obsidian as any).Platform.isDesktopApp,
    }));
    expect(platform.isAndroidApp).toBe(true);
    expect(platform.isDesktopApp).toBe(false);
  });

  it('connection settings and credentials are in place', async function () {
    const state = await browser.executeObsidian(({ app }) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      return { username: p.settings.username, secretId: p.settings.passwordSecretId };
    });
    expect(state.username).toBe(env.values.NEXTCLOUD_USER);
    expect(state.secretId).toBeTruthy();
  });

  it('[SPEC:AND-4] a locally created note reaches the server with identical content', async function () {
    const rel = `${stamp}-local-to-remote.md`;
    const content = `local origin ${stamp}\n`;
    created.push(rel);

    await browser.executeObsidian(
      async ({ app }, path: string, body: string) => {
        await app.vault.adapter.write(path, body);
      },
      rel,
      content,
    );

    await browser.executeObsidianCommand('nextcloud-sync:sync-now');
    try {
      await browser.waitUntil(async () => (await probe!.get(rel)).status === 200, {
        timeout: 120_000,
        interval: 3_000,
        timeoutMsg: `${rel} never appeared on the server`,
      });
    } catch (e) {
      // The plugin's own log explains why the file never appeared.
      throw new Error(`${(e as Error).message}\n--- plugin debug log ---\n${await pluginLogTail()}`);
    }

    const remote = await probe!.get(rel);
    // Byte comparison, not string: a Capacitor body-length bug shows up here and nowhere else.
    expect(remote.body.equals(Buffer.from(content, 'utf-8'))).toBe(true);
  });

  it('[SPEC:AND-4] a note that exists only on the server appears locally with identical content', async function () {
    const rel = `${stamp}-remote-to-local.md`;
    const content = `remote origin ${stamp}\n`;
    created.push(rel);

    const put = await probe!.put(rel, content);
    expect([201, 204]).toContain(put.status);

    await browser.executeObsidianCommand('nextcloud-sync:sync-now');
    let local: string | null;
    try {
      local = (await browser.waitUntil(
        async () => {
          const got = await browser.executeObsidian(
            async ({ app }, path: string) =>
              (await app.vault.adapter.exists(path)) ? app.vault.adapter.read(path) : null,
            rel,
          );
          return got as string | null;
        },
        { timeout: 120_000, interval: 3_000, timeoutMsg: `${rel} never arrived in the vault` },
      )) as string;
    } catch (e) {
      throw new Error(`${(e as Error).message}\n--- plugin debug log ---\n${await pluginLogTail()}`);
    }
    expect(local).toBe(content);
  });
});
