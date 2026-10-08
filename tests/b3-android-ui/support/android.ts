// Android app-state helpers for b-3: reproduce the OS suspending a WebView's timers when the app is not
// frontmost (issue #34); desktop Electron keeps running them.
// suspend() backgrounds the app with the process alive ("approve in the browser, come back"). restart() kills
// the process and loses in-memory state, so use it only for cold-start cases.
// Unverified on a real device: if a scenario relying on suspend() passes with the fix reverted, raise
// BACKGROUND_SETTLE_MS or use startOtherApp().
import { browser } from '@wdio/globals';

export const OBSIDIAN_PACKAGE = 'md.obsidian';

const KEYCODE_HOME = 3;

// Stay backgrounded long enough for the OS to act on the transition.
export const BACKGROUND_SETTLE_MS = 5_000;

async function shell(command: string, args: string[] = []): Promise<unknown> {
  return browser.execute('mobile: shell', { command, args });
}

export async function sendToBackground(): Promise<void> {
  await shell('input', ['keyevent', String(KEYCODE_HOME)]);
}

export async function bringToForeground(): Promise<void> {
  await browser.execute('mobile: activateApp', { appId: OBSIDIAN_PACKAGE });
}

// The process is never killed, so anything the plugin left running can still be resumed.
export async function suspend(ms: number = BACKGROUND_SETTLE_MS): Promise<void> {
  // The HOME key alone did not suspend the WebView's timers on this image (a scenario still passed with the
  // issue #34 fix reverted), so a real activity is also pushed in front of Obsidian.
  await sendToBackground();
  await startOtherApp();
  await browser.pause(ms);
  await bringToForeground();
}

// Destroys the in-memory state a resume-path test needs; use only when a cold start is under test.
export async function restart(): Promise<void> {
  await browser.execute('mobile: terminateApp', { appId: OBSIDIAN_PACKAGE });
  await browser.execute('mobile: activateApp', { appId: OBSIDIAN_PACKAGE });
}

export async function startOtherApp(): Promise<void> {
  // Settings is guaranteed to exist on a google_apis image; a VIEW intent needs a browser, which is
  // not. This must never be the thing that makes the test flaky.
  await shell('am', ['start', '-n', 'com.android.settings/.Settings']);
}

// Android inherits the POSIX NAME_MAX.
export const NAME_MAX_BYTES = 255;

// Sits just under NAME_MAX so the plugin's temp-name handling is the only slack left.
export function filenameOfByteLength(bytes: number, suffix = '.md'): string {
  const suffixBytes = Buffer.byteLength(suffix, 'utf-8');
  if (bytes <= suffixBytes) throw new Error(`bytes must exceed the suffix (${suffixBytes})`);
  return 'x'.repeat(bytes - suffixBytes) + suffix;
}
