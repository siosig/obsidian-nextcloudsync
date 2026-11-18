// Live behaviour of the app password (docs/spec.md §15.2): one running plugin, one sync engine. A wrong start-up
// password, rewriting the selected secret, selecting another secret and selecting a secret with no value all take effect
// on the next sync, with no restart and no engine re-creation between the steps.
import { browser, expect } from '@wdio/globals';
import { requireUiEnv } from '../support/env';

const ui = requireUiEnv();
const SECRET_A = 'b2-apw-a';
const SECRET_B = 'b2-apw-b';
const SECRET_MISSING = 'b2-apw-missing';
const WRONG_VALUE = 'wrong-password';
// Same string as the plugin's legacy credentials key; it is not exported, so it is repeated here.
const LEGACY_KEY = 'obsidian-nextcloudsync-password';

interface StepSpec {
  // Secret values to write before the sync (id -> value).
  secrets: Record<string, string>;
  // When set, the secret selection is switched to this id and saved before the sync.
  select?: string;
  // Fails the test when the legacy stored password is present (it would mask a missing secret).
  requireNoLegacy?: boolean;
}

interface StepResult {
  errorCount: number;
  messages: string[];
}

interface OriginalTiming {
  startupSyncDelaySeconds: number;
  syncIntervalMinutes: number;
}

// The auto-sync timing found before the scenario; null until `silenceAutoSync` has run. Put back by `restore`.
let originalTiming: OriginalTiming | null = null;

// Step 0a (once, before the engine is created): turn the start-up sync and the periodic sync off. `initSyncEngine`
// schedules a `syncManual` after `startupSyncDelaySeconds`; if it ran before a step's `runSyncNow`, that call would
// be skipped (the engine is already running) and the step would read the previous sync's summary.
async function silenceAutoSync(): Promise<OriginalTiming> {
  return (await browser.executeObsidian(async ({ app }) => {
    const p = (app as any).plugins.plugins['nextcloud-sync'];
    const original = {
      startupSyncDelaySeconds: p.settings.startupSyncDelaySeconds as number,
      syncIntervalMinutes: p.settings.syncIntervalMinutes as number,
    };
    p.settings.startupSyncDelaySeconds = 0;
    p.settings.syncIntervalMinutes = 0;
    await p.saveSettings?.();
    return original;
  })) as OriginalTiming;
}

// Step 0 (once, before the first sync): point the plugin at the test server, select secret A holding a wrong value,
// turn watch mode off and create the sync engine, so the engine starts under the wrong password.
async function startWithWrongPassword(): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, server: string, user: string, secretId: string, wrong: string) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      p.settings.serverUrl = server;
      p.settings.username = user;
      p.settings.passwordSecretId = secretId;
      p.settings.watchOnChangeEnabled = false;
      app.secretStorage.setSecret(secretId, wrong);
      await p.saveData?.(p.settings);
      await p.initSyncEngine();
    },
    ui.values.NEXTCLOUD_SERVER_URL,
    ui.values.NEXTCLOUD_USER,
    SECRET_A,
    WRONG_VALUE,
  );
}

// One step = one executeObsidian call: apply the change, run one sync on the existing engine, report the outcome.
// It never re-creates the engine or reloads the plugin.
async function syncAfter(spec: StepSpec): Promise<StepResult> {
  return browser.executeObsidian(
    async ({ app }, step: StepSpec, legacyKey: string) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      if (step.requireNoLegacy) {
        const legacy = (app as any).loadLocalStorage(legacyKey);
        if (legacy !== null && legacy !== undefined && legacy !== '') throw new Error('legacy password present');
      }
      for (const [id, value] of Object.entries(step.secrets)) app.secretStorage.setSecret(id, value);
      if (step.select !== undefined) {
        p.settings.passwordSecretId = step.select;
        await p.saveSettings();
      }
      // A sync scheduled before this test may still be running; runSyncNow would be skipped while it is.
      const deadline = Date.now() + 60_000;
      while (p.syncEngine.running) {
        if (Date.now() > deadline) throw new Error('a sync is still running before the step');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await p.runSyncNow();
      const s = p.syncEngine.getLastSessionSummary();
      return {
        errorCount: s?.errorCount ?? -1,
        messages: (s?.errors ?? []).map((e: { message: string }) => e.message),
      };
    },
    spec,
    LEGACY_KEY,
  );
}

// Step 6: put the shared secret selection, its value, watch mode and the auto-sync timing back for the scenarios that
// follow.
async function restore(): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, secretId: string, password: string, timing: OriginalTiming | null) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      app.secretStorage.setSecret(secretId, password);
      p.settings.passwordSecretId = secretId;
      p.settings.watchOnChangeEnabled = true;
      if (timing) {
        p.settings.startupSyncDelaySeconds = timing.startupSyncDelaySeconds;
        p.settings.syncIntervalMinutes = timing.syncIntervalMinutes;
      }
      await p.saveData?.(p.settings);
    },
    SECRET_A,
    ui.values.NEXTCLOUD_PASSWORD,
    originalTiming,
  );
}

describe('[contract][appPassword] the app password follows the secret store across syncs', function () {
  after(async function () {
    if (!ui.ok) return;
    await restore();
  });

  it('[SPEC:APW-B2-1] a wrong start-up password, rewriting, reselecting and clearing the secret apply to the next sync without a restart', async function () {
    if (!ui.ok) this.skip();
    const correct = ui.values.NEXTCLOUD_PASSWORD;

    // Step 0: no start-up or periodic sync, then start the engine under a wrong password.
    originalTiming = await silenceAutoSync();
    await startWithWrongPassword();

    // Step 1: the wrong value is rejected by the server.
    const wrongStart = await syncAfter({ secrets: {} });
    expect(wrongStart.errorCount).toBeGreaterThanOrEqual(1);
    expect(wrongStart.messages.some((m) => m.includes('401'))).toBe(true);

    // Step 2: rewrite only the selected secret's value; the next sync authenticates with it.
    const rewritten = await syncAfter({ secrets: { [SECRET_A]: correct } });
    expect(rewritten.errorCount).toBe(0);

    // Step 3: select another secret holding a wrong value after the connection was made.
    const reselectedWrong = await syncAfter({ secrets: { [SECRET_B]: WRONG_VALUE }, select: SECRET_B });
    expect(reselectedWrong.errorCount).toBeGreaterThanOrEqual(1);
    expect(reselectedWrong.messages.some((m) => m.includes('401'))).toBe(true);

    // Step 4: select the first secret again.
    const reselectedRight = await syncAfter({ secrets: {}, select: SECRET_A });
    expect(reselectedRight.errorCount).toBe(0);

    // Step 5: select a secret with no value; a stored legacy password would mask it, so it must be absent.
    const cleared = await syncAfter({ secrets: {}, select: SECRET_MISSING, requireNoLegacy: true });
    expect(cleared.messages.some((m) => m.includes('App password not found in credentials'))).toBe(true);
    expect(cleared.messages.some((m) => m.includes('401'))).toBe(false);

    // Step 6: restore the selection, value and watch mode.
    await restore();
  });
});
