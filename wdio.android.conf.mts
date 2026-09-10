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
import { execFileSync } from 'child_process';
import { requireAndroidEnv } from './tests/b3-android-ui/support/env';
import { collectDiagnosticsOnFailure } from './tests/b3-android-ui/support/diagnostics';

const android = requireAndroidEnv();

// Everything the harness sideloads: Appium's helpers plus the app under test. All of them are
// installed into /data, and all of them are lost when the emulator restarts.
const SIDELOADED_PACKAGES = [
  'io.appium.settings',
  'io.appium.uiautomator2.server',
  'io.appium.uiautomator2.server.test',
  'md.obsidian',
] as const;

function adb(args: string[], timeoutMs: number): string {
  return execFileSync('adb', args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Block until the device answers as a fully booted system, not merely as a connected one.
 *
 * `adb wait-for-device` returns as soon as adbd is up, which on a restarting emulator is minutes
 * before the system services exist — ask anything in that window and you get
 * `cmd: Can't find service: package`. Appium walks into it too (`Can't find service: settings`),
 * and reading the package database there is what produces the stale answer this whole hook exists
 * to defend against. `sys.boot_completed` plus a package-service call that actually succeeds is the
 * cheapest honest test that the window has closed.
 */
async function waitForBootedDevice(deadlineMs: number): Promise<void> {
  adb(['wait-for-device'], deadlineMs);
  const giveUpAt = Date.now() + deadlineMs;
  for (;;) {
    try {
      if (adb(['shell', 'getprop', 'sys.boot_completed'], 15_000).trim() === '1') {
        adb(['shell', 'pm', 'list', 'packages'], 30_000); // throws while the service is still absent
        return;
      }
    } catch {
      // Still coming up. Fall through to the deadline check and try again.
    }
    if (Date.now() > giveUpAt) throw new Error(`device was still booting after ${deadlineMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

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
    ['appium', {
      args: {
        allowInsecure: '*:chromedriver_autodownload,*:adb_shell',
        // When session creation itself fails, the afterTest collector gets nothing: it works through
        // the `browser` object, and there is no browser. The server's own log is then the only record
        // of what happened — which install/uninstall ran, in what order, and what `am start` said.
        // Written under the diagnostics directory so the runner's existing rsync brings it back.
        log: path.resolve('.b3-diagnostics/appium-server.log'),
        logLevel: 'debug',
        logTimestamp: true,
      },
    }],
  ],
  reporters: ['obsidian'], // shows the Obsidian version instead of Chromium's
  // Separate from b-2's `.obsidian-cache`: the Android app downloads are a
  // different artifact set, and sharing one directory would let the two layers
  // invalidate each other's cache (gitignored).
  cacheDir: path.resolve('.obsidian-cache-android'),
  // Emulator round-trips are far slower than the desktop app's.
  mochaOpts: { ui: 'bdd', timeout: 180000 },
  logLevel: 'warn',

  /**
   * Wait for a fully booted device, then clear package records left behind by apps that an emulator
   * restart has already removed.
   *
   * The emulator is EXPECTED to die mid-run — `ansible/templates/emulator.service.j2` says so in as
   * many words, and carries `Restart=on-failure` precisely because of it. What that restart takes
   * with it is every sideloaded APK: the AVD boots with `-no-snapshot`, and afterwards
   * `pm list packages` no longer lists io.appium.settings, the UiAutomator2 servers, or md.obsidian.
   *
   * The damage is done by what it leaves BEHIND. `dumpsys package <pkg>` still answers with a
   * husk of a record — `pkg=null`, but a real `versionName` — and that is exactly the field
   * appium-adb reads to decide whether to install. It concludes "191 === 191, no need to
   * install/upgrade", skips the install, and launches an app that is not there. `am start-activity`
   * answers `Error type 3 / Activity class {io.appium.settings/.Settings} does not exist`, no
   * service ever starts, and `SettingsApp.requireRunning()` spends 30s waiting for one before
   * failing with "Appium Settings app is not running" — a message that names neither the restart nor
   * the missing app. The record never expires, so EVERY later spec in the run repeats it: six of
   * seven on 2026-09-10. The same husk hit md.obsidian on 2026-09-08, where it surfaced as the
   * equally misleading "Activity name '.md.obsidian.MainActivity' doesn't exist".
   *
   * `pm list packages` is the honest answer to "is this app really here", so anything it does not
   * list is uninstalled — which costs nothing when there is no record, and clears the husk when
   * there is. The driver's own check then reports "not installed" and reinstalls, which is all it
   * ever needed to do.
   *
   * This is the one place a local `adb` is spawned, and it has to be: the hook runs BEFORE the
   * session exists, so there is no `browser` to route `mobile: shell` through the way
   * tests/b3-android-ui/support/diagnostics.ts does. Under `pnpm test:b3:instance` — the release
   * gate's path — wdio runs ON the AVD host with adb on PATH, so this reaches the device directly.
   * A manual `pnpm test:b3` from a machine that only talks to a remote host has no local adb; there
   * the call fails, the warning is logged, and the run proceeds exactly as it did before.
   *
   * Best-effort by design: a failure here is logged, never thrown. If adb is genuinely unusable the
   * session creation that follows will say so far more precisely than this hook could.
   */
  async beforeSession() {
    try {
      // The device may be mid-restart at this exact moment (that is the whole point), so wait for a
      // BOOTED one rather than racing it. Bounded: a hang here would stall the run with no diagnosis.
      await waitForBootedDevice(240_000);
      const installed = new Set(
        adb(['shell', 'pm', 'list', 'packages'], 30_000)
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('package:'))
          .map((line) => line.slice('package:'.length)),
      );
      for (const pkg of SIDELOADED_PACKAGES) {
        if (installed.has(pkg)) continue;
        try {
          adb(['shell', 'pm', 'uninstall', pkg], 30_000);
          // eslint-disable-next-line no-console
          console.warn(`[b-3] cleared a stale package record for ${pkg} (the emulator restarted and took the APK with it)`);
        } catch {
          // No record to clear is the normal case, and `pm uninstall` fails loudly for it.
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[b-3] could not check for stale package records: ${String(e)}`);
    }
  },

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
