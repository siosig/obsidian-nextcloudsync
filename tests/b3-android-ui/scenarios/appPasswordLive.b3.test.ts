// [SPEC:APW-B3-1] The app password is read at every sync, on a real Android device (docs/spec.md §15.2).
// One sync engine, started with a wrong password, follows the secret through a rewrite, a re-selection and a
// cleared selection without a restart. Only the real plugin on the real device shows that the secretStorage
// wiring and the engine's per-sync password read work together.
//
// The engine must stay the same instance for steps 1-6: seedConnection, initSyncEngine and a plugin reload
// rebuild it, and a rebuilt engine reads the password afresh, so the check would pass without the fix. Only
// step 0 builds the engine. Only steps 1 and 3 sync with a wrong password, to keep Nextcloud's brute-force
// throttling out of the timing.
import { browser, expect } from '@wdio/globals';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';
import { PASSWORD_SECRET_ID, seedConnection } from '../support/plugin';

const env = requireAndroidEnv();

const SECRET_A = 'b3-apw-a';
const SECRET_B = 'b3-apw-b';
const SECRET_MISSING = 'b3-apw-missing';
const WRONG_PASSWORD = 'wrong-password';
// Same literal as LEGACY_CREDENTIALS_KEY in src/settings/SettingTab.ts, which is not exported.
const LEGACY_CREDENTIALS_KEY = 'obsidian-nextcloudsync-password';

interface StepResult {
  errorCount: number;
  messages: string[];
}

interface OriginalTiming {
  startupSyncDelaySeconds: number;
  syncIntervalMinutes: number;
}

describe('[SPEC:APW-B3-1] b-3 — the app password follows the secret across syncs', function () {
  // Watch mode is switched off for the scenario and put back as it was found.
  let originalWatch: boolean | undefined;
  // The start-up sync and the periodic sync are switched off for the scenario too (see step 0) and put back the same
  // way; null until step 0 has run.
  let originalTiming: OriginalTiming | null = null;

  before(async function () {
    requireEnvOrSkip(this);
  });

  after(async function () {
    if (!env.ok) return;
    // Back to what seedConnection leaves for the next scenarios: its secret id holding the working password.
    await browser.executeObsidian(
      async ({ app }, secretId: string, pw: string, watch: boolean | undefined, timing: OriginalTiming | null) => {
        const p = (app as any).plugins.plugins['nextcloud-sync'];
        if (!p) return;
        (app as any).secretStorage.setSecret(secretId, pw);
        p.settings.passwordSecretId = secretId;
        if (watch !== undefined) p.settings.watchOnChangeEnabled = watch;
        if (timing) {
          p.settings.startupSyncDelaySeconds = timing.startupSyncDelaySeconds;
          p.settings.syncIntervalMinutes = timing.syncIntervalMinutes;
        }
        await p.saveSettings?.();
      },
      PASSWORD_SECRET_ID,
      env.values.NEXTCLOUD_PASSWORD,
      originalWatch,
      originalTiming,
    );
  });

  it('[SPEC:APW-B3-1] a wrong start-up password, rewriting, reselecting and clearing the secret apply to the next sync without a restart', async function () {
    const v = env.values;
    const correct = v.NEXTCLOUD_PASSWORD;

    // Step 0: connection settings and a wrong password under secret A, then the one and only engine start.
    // First turn the start-up sync and the periodic sync off: seedConnection and initSyncEngine each schedule a
    // `syncManual` after `startupSyncDelaySeconds`, and one running before a step's `runSyncNow` would make that call
    // return at once (the engine is already running), so the step would read the previous sync's summary.
    originalTiming = (await browser.executeObsidian(async ({ app }) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      if (!p) throw new Error('the nextcloud-sync plugin is not loaded');
      const original = {
        startupSyncDelaySeconds: p.settings.startupSyncDelaySeconds as number,
        syncIntervalMinutes: p.settings.syncIntervalMinutes as number,
      };
      p.settings.startupSyncDelaySeconds = 0;
      p.settings.syncIntervalMinutes = 0;
      await p.saveSettings?.();
      return original;
    })) as OriginalTiming;
    await seedConnection(v.NEXTCLOUD_SERVER_URL, v.NEXTCLOUD_USER, v.NEXTCLOUD_PASSWORD);
    originalWatch = (await browser.executeObsidian(async ({ app }, secretId: string, wrong: string) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      const watch = p.settings.watchOnChangeEnabled as boolean;
      p.settings.passwordSecretId = secretId;
      p.settings.watchOnChangeEnabled = false;
      (app as any).secretStorage.setSecret(secretId, wrong);
      await p.saveSettings?.();
      await p.initSyncEngine();
      return watch;
    }, SECRET_A, WRONG_PASSWORD)) as boolean;

    // Step 1: the engine started with the wrong password, so the sync is rejected.
    const s1 = (await browser.executeObsidian(async ({ app }) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      // A sync scheduled before this step may still be running; runSyncNow would be skipped while it is.
      const deadline = Date.now() + 60_000;
      while (p.syncEngine.running) {
        if (Date.now() > deadline) throw new Error('a sync is still running before the step');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await p.runSyncNow();
      const s = p.syncEngine.getLastSessionSummary();
      return { errorCount: s?.errorCount ?? -1, messages: (s?.errors ?? []).map((e: { message: string }) => e.message) };
    })) as StepResult;
    expect(s1.errorCount).toBeGreaterThanOrEqual(1);
    expect(s1.messages.join('\n')).toContain('401');

    // Step 2: rewrite the selected secret's value only. The next sync must authenticate with it.
    const s2 = (await browser.executeObsidian(async ({ app }, secretId: string, pw: string) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      (app as any).secretStorage.setSecret(secretId, pw);
      // A sync scheduled before this step may still be running; runSyncNow would be skipped while it is.
      const deadline = Date.now() + 60_000;
      while (p.syncEngine.running) {
        if (Date.now() > deadline) throw new Error('a sync is still running before the step');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await p.runSyncNow();
      const s = p.syncEngine.getLastSessionSummary();
      return { errorCount: s?.errorCount ?? -1, messages: (s?.errors ?? []).map((e: { message: string }) => e.message) };
    }, SECRET_A, correct)) as StepResult;
    expect(s2.errorCount).toBe(0);

    // Step 3: select another secret holding a wrong password.
    const s3 = (await browser.executeObsidian(async ({ app }, secretId: string, wrong: string) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      (app as any).secretStorage.setSecret(secretId, wrong);
      p.settings.passwordSecretId = secretId;
      await p.saveSettings?.();
      // Capacitor's native HTTP keeps the session cookie Nextcloud set during step 2's successful sync, and
      // Nextcloud's DAV authentication accepts a logged-in session without checking the Basic password. Without
      // clearing it, this step's wrong password is answered 200 even though the plugin sends it. Desktop
      // (b-2) has no such cookie, so only this layer needs it.
      const cookies = (window as any).Capacitor?.Plugins?.CapacitorCookies;
      if (typeof cookies?.clearAllCookies !== 'function') throw new Error('CapacitorCookies is not available');
      await cookies.clearAllCookies();
      // A sync scheduled before this step may still be running; runSyncNow would be skipped while it is.
      const deadline = Date.now() + 60_000;
      while (p.syncEngine.running) {
        if (Date.now() > deadline) throw new Error('a sync is still running before the step');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await p.runSyncNow();
      const s = p.syncEngine.getLastSessionSummary();
      return { errorCount: s?.errorCount ?? -1, messages: (s?.errors ?? []).map((e: { message: string }) => e.message) };
    }, SECRET_B, WRONG_PASSWORD)) as StepResult;
    expect(s3.errorCount).toBeGreaterThanOrEqual(1);
    expect(s3.messages.join('\n')).toContain('401');

    // Step 4: select the secret that holds the working password again.
    const s4 = (await browser.executeObsidian(async ({ app }, secretId: string) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      p.settings.passwordSecretId = secretId;
      await p.saveSettings?.();
      // A sync scheduled before this step may still be running; runSyncNow would be skipped while it is.
      const deadline = Date.now() + 60_000;
      while (p.syncEngine.running) {
        if (Date.now() > deadline) throw new Error('a sync is still running before the step');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await p.runSyncNow();
      const s = p.syncEngine.getLastSessionSummary();
      return { errorCount: s?.errorCount ?? -1, messages: (s?.errors ?? []).map((e: { message: string }) => e.message) };
    }, SECRET_A)) as StepResult;
    expect(s4.errorCount).toBe(0);

    // Step 5: select a secret with no value. The legacy stored password must be absent, or the read would fall
    // back to it and the missing-secret path would never run.
    const s5 = (await browser.executeObsidian(async ({ app }, secretId: string, legacyKey: string) => {
      const p = (app as any).plugins.plugins['nextcloud-sync'];
      const legacy = (app as any).loadLocalStorage(legacyKey);
      if (legacy !== null && legacy !== undefined && legacy !== '') throw new Error('legacy password present');
      p.settings.passwordSecretId = secretId;
      await p.saveSettings?.();
      // A sync scheduled before this step may still be running; runSyncNow would be skipped while it is.
      const deadline = Date.now() + 60_000;
      while (p.syncEngine.running) {
        if (Date.now() > deadline) throw new Error('a sync is still running before the step');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await p.runSyncNow();
      const s = p.syncEngine.getLastSessionSummary();
      return { errorCount: s?.errorCount ?? -1, messages: (s?.errors ?? []).map((e: { message: string }) => e.message) };
    }, SECRET_MISSING, LEGACY_CREDENTIALS_KEY)) as StepResult;
    expect(s5.messages.join('\n')).toContain('App password not found in credentials');
    expect(s5.messages.join('\n')).not.toContain('401');

    // Step 6 (cleanup) runs in the `after` hook, so it also runs when an expectation above fails.
  });
});
