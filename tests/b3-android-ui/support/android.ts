// Android app-state helpers for b-3.
//
// The point of these helpers is to reproduce what the OS does to a WebView when the app stops being
// frontmost — it suspends timers. That is the condition that broke browser sign-in (issue #34) and it
// is not reproducible on desktop, where an unfocused Electron window keeps running its timers.
//
// There are two ways to stop being frontmost and they are NOT equivalent:
//
//   suspend()   — send the app to the background with the HOME key. The process stays alive, the
//                 WebView keeps its state, and timers are throttled/suspended by the OS. This models
//                 "the user tapped a link, approved in the browser, and came back", which is the real
//                 issue #34 scenario.
//   restart()   — terminateApp + activateApp. The process is killed and started fresh, so in-memory
//                 state is LOST. A poll loop that "resumes" here proves nothing about issue #34,
//                 because there is no loop left to resume.
//
// Prefer suspend(). restart() exists for cases that genuinely need a cold start.
//
// NOTE (verify on the first real run, see research.md R-8): whether the HOME key alone is enough to
// get the OS to suspend the WebView's timers on this emulator image has not been confirmed against a
// live device yet. If a scenario that relies on suspend() passes even with the fix reverted, this is
// the first thing to check — raise BACKGROUND_SETTLE_MS, or push a second app to the foreground with
// `startOtherApp()`, before concluding the code is correct.
import { browser } from '@wdio/globals';

/** Obsidian's Android package id (confirmed from wdio-obsidian-service's own device paths). */
export const OBSIDIAN_PACKAGE = 'md.obsidian';

/** Android KEYCODE_HOME. */
const KEYCODE_HOME = 3;

/** How long to stay backgrounded before coming back, so the OS actually acts on the transition. */
export const BACKGROUND_SETTLE_MS = 5_000;

async function shell(command: string, args: string[] = []): Promise<unknown> {
  return browser.execute('mobile: shell', { command, args });
}

/** Sends the app to the background via the HOME key, keeping the process alive. */
export async function sendToBackground(): Promise<void> {
  await shell('input', ['keyevent', String(KEYCODE_HOME)]);
}

/** Brings Obsidian back to the foreground without restarting it. */
export async function bringToForeground(): Promise<void> {
  await browser.execute('mobile: activateApp', { appId: OBSIDIAN_PACKAGE });
}

/**
 * Backgrounds the app, waits, then foregrounds it — the transition pair that issue #34 depends on.
 * The process is never killed, so anything the plugin left running is still there to be resumed.
 */
export async function suspend(ms: number = BACKGROUND_SETTLE_MS): Promise<void> {
  // The HOME key alone did NOT suspend the webview's timers on this emulator image: a scenario that
  // depends on the suspension still passed with the issue #34 fix reverted. Pushing a real activity
  // in front of Obsidian is the stronger form, so it is what suspend() does — verified by the revert
  // check in tasks.md (T030), not assumed.
  await sendToBackground();
  await startOtherApp();
  await browser.pause(ms);
  await bringToForeground();
}

/**
 * Kills and relaunches the app. Use only when a cold start is what is under test — this destroys the
 * in-memory state that a resume-path test needs to still exist.
 */
export async function restart(): Promise<void> {
  await browser.execute('mobile: terminateApp', { appId: OBSIDIAN_PACKAGE });
  await browser.execute('mobile: activateApp', { appId: OBSIDIAN_PACKAGE });
}

/**
 * Pushes another app in front of Obsidian. Stronger than the HOME key when the OS needs a real
 * foreground competitor before it will suspend the WebView.
 */
export async function startOtherApp(): Promise<void> {
  // Settings is guaranteed to exist on a google_apis image; a VIEW intent needs a browser, which is
  // not. This must never be the thing that makes the test flaky.
  await shell('am', ['start', '-n', 'com.android.settings/.Settings']);
}

/** Longest filename the platform accepts, in bytes. Android inherits the POSIX NAME_MAX. */
export const NAME_MAX_BYTES = 255;

/**
 * Builds a filename whose UTF-8 length is exactly `bytes`, ending with `suffix`.
 * Used to sit just under NAME_MAX so the plugin's temp-name handling is the only slack left.
 */
export function filenameOfByteLength(bytes: number, suffix = '.md'): string {
  const suffixBytes = Buffer.byteLength(suffix, 'utf-8');
  if (bytes <= suffixBytes) throw new Error(`bytes must exceed the suffix (${suffixBytes})`);
  return 'x'.repeat(bytes - suffixBytes) + suffix;
}
