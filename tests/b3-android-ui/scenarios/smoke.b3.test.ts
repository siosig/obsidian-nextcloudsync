// b-3 smoke: prove the plugin actually runs on a real Android runtime and completes one sync
// round trip in each direction.
//
// The first two cases (plugin enabled, settings persist) are PRECONDITIONS, not b-3 clauses —
// b-2 already covers them on desktop, and the dedup rule says one behaviour lives in one class.
// They are here so a failure points at the harness rather than at the sync engine.
//
// The round-trip cases ARE b-3 clauses (AND-4): on Android the transfer goes through Obsidian's
// Capacitor `requestUrl`, a different implementation from the Electron one b-2 exercises. Every
// mobile transfer bug this project has shipped lived in that implementation.
import { browser, expect } from '@wdio/globals';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';
import { seedConnection, pluginLogTail } from '../support/plugin';
import { RemoteProbe } from '../support/webdav';

const env = requireAndroidEnv();

/** Unique per run so a crashed run never poisons the next one. */
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

  // --- preconditions (not clause-tagged; see file header) ------------------------------------
  it('the Nextcloud Sync plugin is installed and enabled', async () => {
    const enabled = await browser.executeObsidian(
      ({ app }) => !!(app as any).plugins.enabledPlugins.has('nextcloud-sync'),
    );
    expect(enabled).toBe(true);
  });

  it('the plugin reports the Android runtime, not desktop', async () => {
    // Guards against the whole suite silently running on a desktop build: every b-3 clause below
    // assumes Capacitor, and would prove nothing under Electron.
    const platform = await browser.executeObsidian(({ obsidian }) => ({
      isAndroidApp: (obsidian as any).Platform.isAndroidApp,
      isDesktopApp: (obsidian as any).Platform.isDesktopApp,
    }));
    expect(platform.isAndroidApp).toBe(true);
    expect(platform.isDesktopApp).toBe(false);
  });

  it('connection settings and credentials are in place', async function () {
    // seedConnection() already ran in before(); this asserts the plugin actually kept them, which is
    // the precondition every sync case below depends on.
    const state = await browser.executeObsidian(({ app }) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      return { username: p.settings.username, secretId: p.settings.passwordSecretId };
    });
    expect(state.username).toBe(env.values.NEXTCLOUD_USER);
    expect(state.secretId).toBeTruthy();
  });

  // --- b-3 clauses ---------------------------------------------------------------------------
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
      // A bare "never appeared" says nothing about WHY. The plugin's own log does.
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
