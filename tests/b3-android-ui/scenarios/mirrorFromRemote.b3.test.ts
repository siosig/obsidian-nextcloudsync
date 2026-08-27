// [SPEC:AND-5] "Mirror from remote" must complete on a real Android runtime.
//
// Reported from a real device: like browser sign-in, this action times out on Android. Both share a
// shape — a long-running operation driven from the WebView over Capacitor's `requestUrl` — which is
// why they fail together there and pass everywhere else.
//
// Why this cannot live in another layer: the planning stage lists the WHOLE remote over the mobile
// HTTP implementation. b-1 exercises the server without that implementation, and b-2 runs Electron's
// net stack instead of Capacitor's. Neither can reproduce a Capacitor-side timeout.
//
// The test drives `planRemoteMirror` / `applyRemoteMirror` directly rather than the modal: the modal
// is a progress surface over exactly these two calls (MirrorFromRemoteModal's `plan`/`apply` hooks),
// so this covers the network path that times out without depending on dialog markup.
import { browser, expect } from '@wdio/globals';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';
import { seedConnection, pluginLogTail } from '../support/plugin';
import { RemoteProbe } from '../support/webdav';

const env = requireAndroidEnv();
const stamp = `b3-mirror-${process.pid}`;

/** Generous, but far below "hangs forever" — the reported symptom is a timeout, not slowness. */
const MIRROR_TIMEOUT_MS = 180_000;

describe('[SPEC:AND-5] b-3 — mirror from remote completes on Android', function () {
  let probe: RemoteProbe | undefined;
  const created: string[] = [];

  before(async function () {
    requireEnvOrSkip(this);
    probe = await RemoteProbe.forCurrentVault();
    await seedConnection(
      env.values.NEXTCLOUD_SERVER_URL,
      env.values.NEXTCLOUD_USER,
      env.values.NEXTCLOUD_PASSWORD,
    );
  });

  after(async function () {
    if (!probe) return;
    for (const p of created) await probe.removeQuietly(p);
  });

  it('plans a mirror without timing out, and the plan sees the remote files', async function () {
    // Seed a few remote-only notes, including a name that needs encoding — the planning stage lists
    // the remote, so an encoding fault surfaces here as an empty or short plan.
    const names = [`${stamp}-a.md`, `${stamp}-b.md`, `${stamp}-日本語 名前.md`];
    for (const n of names) {
      created.push(n);
      const put = await probe!.put(n, `mirror ${n}\n`);
      expect([201, 204]).toContain(put.status);
    }

    const outcome = await browser.executeObsidian(
      async ({ app }, budgetMs: number) => {
        const plugin = (app as any).plugins.plugins['nextcloud-sync'];
        const engine = plugin?.syncEngine;
        if (!engine) return { ok: false, reason: 'sync engine is not configured' };
        const phases: string[] = [];
        const started = Date.now();
        try {
          const plan = await Promise.race([
            engine.planRemoteMirror((label: string) => phases.push(label)),
            new Promise((_r, reject) =>
              setTimeout(() => reject(new Error('planRemoteMirror timed out')), budgetMs),
            ),
          ]);
          return {
            ok: true,
            elapsedMs: Date.now() - started,
            phases,
            // MirrorPlan.ok is false when the authoritative remote listing could NOT be obtained
            // completely — which is exactly what a timed-out listing looks like from the inside.
            planOk: (plan as any)?.ok,
            planReason: (plan as any)?.reason ?? null,
            downloads: (plan as any)?.downloads?.length ?? 0,
          };
        } catch (e) {
          return { ok: false, reason: (e as Error).message, elapsedMs: Date.now() - started, phases };
        }
      },
      MIRROR_TIMEOUT_MS,
    );

    if (!(outcome as any).ok) {
      throw new Error(
        `mirror planning failed: ${(outcome as any).reason} ` +
          `(after ${(outcome as any).elapsedMs}ms, phases=${JSON.stringify((outcome as any).phases)})\n` +
          `--- plugin debug log ---\n${await pluginLogTail()}`,
      );
    }
    // A plan that came back "not ok" means the remote listing was incomplete — the failure mode the
    // report describes. Surface the reason instead of letting it hide behind a zero download count.
    if ((outcome as any).planOk !== true) {
      throw new Error(`mirror plan came back not-ok: ${(outcome as any).planReason}`);
    }
    // The plan must actually have found the remote side; an empty plan would pass a "did not time
    // out" check while proving nothing.
    expect((outcome as any).downloads).toBeGreaterThanOrEqual(names.length);
  });

  it('applies the mirror so the remote-only notes land in the vault', async function () {
    const outcome = await browser.executeObsidian(
      async ({ app }, budgetMs: number) => {
        const plugin = (app as any).plugins.plugins['nextcloud-sync'];
        const engine = plugin?.syncEngine;
        if (!engine) return { ok: false, reason: 'sync engine is not configured' };
        try {
          const plan = await engine.planRemoteMirror();
          const result = await Promise.race([
            engine.applyRemoteMirror(plan),
            new Promise((_r, reject) =>
              setTimeout(() => reject(new Error('applyRemoteMirror timed out')), budgetMs),
            ),
          ]);
          return { ok: true, result: JSON.parse(JSON.stringify(result ?? {})) };
        } catch (e) {
          return { ok: false, reason: (e as Error).message };
        }
      },
      MIRROR_TIMEOUT_MS,
    );

    if (!(outcome as any).ok) {
      throw new Error(
        `mirror apply failed: ${(outcome as any).reason}\n` +
          `--- plugin debug log ---\n${await pluginLogTail()}`,
      );
    }

    const present = await browser.executeObsidian(
      async ({ app }, path: string) => app.vault.adapter.exists(path),
      `${stamp}-日本語 名前.md`,
    );
    expect(present).toBe(true);
  });
});
