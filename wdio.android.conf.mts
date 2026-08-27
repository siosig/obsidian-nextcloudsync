// Classification "b-3" (live Nextcloud + real Obsidian on a real Android runtime)
// runner config. Appium + UiAutomator2 drive the actual Obsidian APK inside an
// Android Virtual Device, so this layer exercises the Capacitor runtime that
// b-2 (Electron desktop) can never reproduce. Runs ONLY via `pnpm test:b3`
// (normally through `pnpm test:b3:instance`); never in the default `pnpm test`
// or CI.
//
// This file is deliberately separate from wdio.conf.mts (b-2): the Android
// capabilities are incompatible with the desktop ones, and branching inside a
// single config would put the b-2 execution path at risk.
//
// Prerequisites (all satisfied on the AVD host instance, not on the dev VM):
//   pnpm add -D appium appium-uiautomator2-driver @wdio/appium-service
//   pnpm build   # produce main.js / manifest.json / styles.css at repo root
//   an AVD named `obsidian_test` (Android 13 / API 33, google_apis, x86_64,
//   started with a writable system image so the test CA can be injected)
// The dev VM has no hardware virtualization; run this on the AVD host.
import * as path from 'path';
import { requireAndroidEnv } from './tests/b3-android-ui/support/env';
import { collectDiagnosticsOnFailure } from './tests/b3-android-ui/support/diagnostics';

const android = requireAndroidEnv();

// The AVD name is owned by the host provisioning, so it is READ here, never redeclared: the runner
// exports it from the host's connection.json. Hard-coding a second copy is how the two drift
// apart and the run dies with "avd not found". The fallback only serves a manual `pnpm test:b3`.
const AVD_NAME = process.env.B3_AVD_NAME ?? 'node33';

export const config: WebdriverIO.Config = {
  runner: 'local',
  framework: 'mocha',
  specs: ['./tests/b3-android-ui/scenarios/**/*.b3.test.ts'],
  maxInstances: 1, // Android tests cannot run in parallel (one AVD per host)

  // NOTE: `specFileRetries` is intentionally absent (FR-005c). Verification
  // failures must never be retried: a retry setting here would silently swallow
  // real regressions, and once the option exists someone will eventually raise
  // its value. Retrying is allowed only while preparing the environment, which
  // scripts/b3-android.sh handles outside the test runner.

  capabilities: [
    {
      browserName: 'obsidian',
      browserVersion: 'latest',
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:avd': AVD_NAME,
      // Keep the emulator/app state between specs; the service resets Obsidian
      // itself when it needs to, and a full reset per spec is far too slow.
      'appium:noReset': true,
      // Several scenarios wait on the SERVER (polling WebDAV from node) for up to two minutes
      // without issuing a single device command. Appium's default 60s idle timeout kills the
      // session in that window, and the symptom is a misleading "session is either terminated
      // or not started" in the middle of an otherwise healthy test.
      'appium:newCommandTimeout': 0,
      'wdio:obsidianOptions': {
        // Install THIS plugin from the repo root build output ("." => main.js +
        // manifest.json); enabled by default.
        plugins: ['.'],
        // Throwaway vault opened as a copy so tests never mutate the template.
        vault: 'tests/b3-android-ui/support/vault',
      },
    } as WebdriverIO.Capabilities,
  ],

  services: [
    'obsidian',
    // chromedriver_autodownload: the WebView driver must match whatever Chrome
    // version the emulator image ships. adb_shell: needed to pull system logs
    // for the failure diagnostics bundle.
    ['appium', { args: { allowInsecure: '*:chromedriver_autodownload,*:adb_shell' } }],
  ],
  reporters: ['obsidian'], // shows the Obsidian version instead of Chromium's
  // Separate from b-2's `.obsidian-cache`: the Android app downloads are a
  // different artifact set, and sharing one directory would let the two layers
  // invalidate each other's cache (gitignored).
  cacheDir: path.resolve('.obsidian-cache-android'),
  // Emulator round-trips are far slower than the desktop app's.
  mochaOpts: { ui: 'bdd', timeout: 180000 },
  logLevel: 'warn',

  onPrepare() {
    // `missing` means "not configured" and `blocked` means "configured, but this
    // host cannot run b-3" (wrong API level, CA not injected, host not ready).
    // Keep them apart so a warning is never misread as the other case.
    if (android.missing.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[b-3] connection info missing (${android.missing.join(', ')}); sync steps will be skipped.`);
    }
    if (android.blocked.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[b-3] AVD host cannot run this layer: ${android.blocked.join('; ')}`);
    }
  },

  async afterTest(test, _context, result) {
    // Diagnostics are collected on failure only (FR-008b): a green run leaves
    // no bundle behind. Collection must never mask the original failure, so it
    // is best-effort here and teardown proceeds regardless (FR-008c).
    if (result.passed) return;
    try {
      await collectDiagnosticsOnFailure(test, result);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[b-3] diagnostics collection failed: ${String(e)}`);
    }
  },
};
