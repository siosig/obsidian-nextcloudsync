// b-3 (real Android UI) failure-diagnostics collector, called from the wdio `afterTest` hook of
// `wdio.android.conf.mts`. It gathers the bundle before the Android runtime is torn down, so a failure can be
// diagnosed from the harvested files alone.
//   * Collect only on failure: a passing test creates no file or directory (returns null first).
//   * Never throw: each item has its own try/catch and the entry point is wrapped, so a broken device
//     connection cannot keep the runner from stopping the environment.
//   * All device interaction goes through WebdriverIO / Appium (`mobile: shell`, `takeScreenshot`, `pullFile`);
//     no local `adb` is spawned because the device is a Redroid container reached over the network.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Gitignored (see `.gitignore`).
export const DIAGNOSTICS_ROOT = '.b3-diagnostics';

// The plugin writes its per-device debug log under this name (src/util/logPaths.ts).
const PLUGIN_LOG_PATTERN = /^nextcloud-debug_.*\.txt$/;

// Caps logcat so a huge ring buffer cannot blow up the bundle.
const DEFAULT_LOGCAT_LINES = 5000;

// Declared locally instead of importing `@wdio/globals` so the module resolves outside a wdio run and takes a stub.
export interface DiagnosticsBrowser {
  execute(script: string, ...args: unknown[]): Promise<unknown>;
  takeScreenshot(): Promise<string>;
  // Appium file-transfer command; returns base64. Absent on non-mobile sessions.
  pullFile?(path: string): Promise<string>;
  // wdio-obsidian-service command; resolves the temporary vault copy path.
  getObsidianPage?(): Promise<{ getVaultPath(): string | Promise<string> }>;
}

export interface DiagnosticsTestInfo {
  title?: string;
  parent?: string;
  fullTitle?: string | (() => string);
  file?: string;
}

export interface DiagnosticsTestResult {
  passed?: boolean;
  error?: { name?: string; message?: string; stack?: string } | null;
  duration?: number;
  retries?: { attempts?: number; limit?: number };
}

export interface CollectDiagnosticsOptions {
  // Browser to drive. Defaults to the wdio `browser` global.
  browser?: DiagnosticsBrowser;
  // Bundle root. Defaults to `DIAGNOSTICS_ROOT` (or `$B3_DIAGNOSTICS_DIR`).
  outputRoot?: string;
  // On-device vault path. Defaults to `$B3_VAULT_PATH`, else `getObsidianPage().getVaultPath()`.
  vaultPath?: string;
  // Plugin `logsFolder` setting; blank means the vault root (the default).
  logsFolder?: string;
  logcatLines?: number;
  // Note about environment-preparation retries. Defaults to `$B3_RETRY_RECORD`.
  retryRecord?: string;
}

export interface DiagnosticItemResult {
  item: 'system_log' | 'screenshot' | 'plugin_debug_log';
  ok: boolean;
  // Bundle-relative file names actually written.
  files: string[];
  // Why the item could not be collected, when `ok` is false.
  reason?: string;
}

export interface DiagnosticBundle {
  scenarioId: string;
  // Absolute path of the bundle directory.
  directory: string;
  testTitle: string;
  testFile?: string;
  failedAt: string;
  durationMs?: number;
  error?: { name?: string; message?: string; stack?: string };
  retryRecord?: string;
  items: DiagnosticItemResult[];
}

// Returns null when the test passed or nothing could be collected; never throws.
// Wire it up as `afterTest: (test, _ctx, result) => collectDiagnosticsOnFailure(test, result)` in `wdio.android.conf.mts`.
export async function collectDiagnosticsOnFailure(
  test: DiagnosticsTestInfo,
  result: DiagnosticsTestResult,
  options: CollectDiagnosticsOptions = {},
): Promise<DiagnosticBundle | null> {
  try {
    if (!isFailure(result)) return null; // Nothing is generated on success.

    const scenarioId = deriveScenarioId(test);
    const root = options.outputRoot ?? process.env.B3_DIAGNOSTICS_DIR ?? DIAGNOSTICS_ROOT;
    const directory = makeBundleDir(resolve(process.cwd(), root), scenarioId);

    const bundle: DiagnosticBundle = {
      scenarioId,
      directory,
      testTitle: fullTitleOf(test),
      testFile: test.file,
      failedAt: new Date().toISOString(),
      durationMs: result.duration,
      error: normalizeError(result.error),
      retryRecord: options.retryRecord ?? process.env.B3_RETRY_RECORD,
      items: [],
    };

    const browser = options.browser ?? globalBrowser();
    if (!browser) {
      for (const item of ['system_log', 'screenshot', 'plugin_debug_log'] as const) {
        bundle.items.push({ item, ok: false, files: [], reason: 'no WebdriverIO browser available' });
      }
    } else {
      // Each collector is independent: one failure must not cost the others.
      bundle.items.push(await collectSystemLog(browser, directory, options.logcatLines));
      bundle.items.push(await collectScreenshot(browser, directory));
      bundle.items.push(await collectPluginDebugLog(browser, directory, options));
    }

    writeSummary(directory, bundle);
    return bundle;
  } catch {
    // Never propagate: teardown depends on this returning.
    return null;
  }
}

async function collectSystemLog(
  browser: DiagnosticsBrowser,
  directory: string,
  lines?: number,
): Promise<DiagnosticItemResult> {
  const file = 'system-log.txt';
  try {
    const out = await browser.execute('mobile: shell', {
      command: 'logcat',
      args: ['-d', '-v', 'threadtime', '-t', String(lines ?? DEFAULT_LOGCAT_LINES)],
    });
    const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    if (!text) return { item: 'system_log', ok: false, files: [], reason: 'logcat returned no output' };
    writeFileSync(join(directory, file), text, 'utf-8');
    return { item: 'system_log', ok: true, files: [file] };
  } catch (e) {
    return { item: 'system_log', ok: false, files: [], reason: describe(e) };
  }
}

async function collectScreenshot(
  browser: DiagnosticsBrowser,
  directory: string,
): Promise<DiagnosticItemResult> {
  const file = 'screenshot.png';
  try {
    const base64 = await browser.takeScreenshot();
    if (!base64) return { item: 'screenshot', ok: false, files: [], reason: 'empty screenshot' };
    writeFileSync(join(directory, file), Buffer.from(base64, 'base64'));
    return { item: 'screenshot', ok: true, files: [file] };
  } catch (e) {
    return { item: 'screenshot', ok: false, files: [], reason: describe(e) };
  }
}

// The host token in `<logsFolder>/nextcloud-debug_<host>.txt` is derived on the device, so list the folder and pull every match.
async function collectPluginDebugLog(
  browser: DiagnosticsBrowser,
  directory: string,
  options: CollectDiagnosticsOptions,
): Promise<DiagnosticItemResult> {
  try {
    const vaultPath = await resolveVaultPath(browser, options);
    if (!vaultPath) {
      return { item: 'plugin_debug_log', ok: false, files: [], reason: 'vault path could not be resolved' };
    }
    if (typeof browser.pullFile !== 'function') {
      return { item: 'plugin_debug_log', ok: false, files: [], reason: 'pullFile is unavailable on this session' };
    }

    const logsFolder = (options.logsFolder ?? process.env.B3_LOGS_FOLDER ?? '').replace(/^\/+|\/+$/g, '');
    const logsDir = logsFolder ? `${trimTrailingSlash(vaultPath)}/${logsFolder}` : trimTrailingSlash(vaultPath);

    const listing = await browser.execute('mobile: shell', { command: 'ls', args: ['-1', logsDir] });
    const names = String(typeof listing === 'string' ? listing : '')
      .split(/\r?\n/)
      .map((n) => n.trim())
      .filter((n) => PLUGIN_LOG_PATTERN.test(n));
    if (names.length === 0) {
      return { item: 'plugin_debug_log', ok: false, files: [], reason: `no debug log found under ${logsDir}` };
    }

    const written: string[] = [];
    const problems: string[] = [];
    for (const name of names) {
      try {
        const base64 = await browser.pullFile(`${logsDir}/${name}`);
        writeFileSync(join(directory, name), Buffer.from(base64, 'base64'));
        written.push(name);
      } catch (e) {
        problems.push(`${name}: ${describe(e)}`);
      }
    }
    return {
      item: 'plugin_debug_log',
      ok: written.length > 0,
      files: written,
      reason: problems.length > 0 ? problems.join('; ') : undefined,
    };
  } catch (e) {
    return { item: 'plugin_debug_log', ok: false, files: [], reason: describe(e) };
  }
}

async function resolveVaultPath(
  browser: DiagnosticsBrowser,
  options: CollectDiagnosticsOptions,
): Promise<string | undefined> {
  if (options.vaultPath) return options.vaultPath;
  if (process.env.B3_VAULT_PATH) return process.env.B3_VAULT_PATH;
  try {
    if (typeof browser.getObsidianPage !== 'function') return undefined;
    const page = await browser.getObsidianPage();
    const path = await page.getVaultPath();
    return path || undefined;
  } catch {
    return undefined;
  }
}

// Written last and even when all collectors failed: knowing nothing could be harvested is itself the diagnosis.
function writeSummary(directory: string, bundle: DiagnosticBundle): void {
  const json = { ...bundle };
  try {
    writeFileSync(join(directory, 'summary.json'), `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
  } catch {
    /* the human-readable summary below is the fallback */
  }
  try {
    writeFileSync(join(directory, 'summary.txt'), renderSummary(bundle), 'utf-8');
  } catch {
    /* nothing further we can do; the caller must still reach teardown */
  }
}

function renderSummary(b: DiagnosticBundle): string {
  const lines: string[] = [
    `scenario   : ${b.scenarioId}`,
    `test       : ${b.testTitle}`,
    `spec file  : ${b.testFile ?? '(unknown)'}`,
    `failed at  : ${b.failedAt}`,
    `duration   : ${b.durationMs === undefined ? '(unknown)' : `${b.durationMs} ms`}`,
    `retries    : ${b.retryRecord ?? '(none recorded)'}`,
    '',
    'error:',
    indent(b.error?.stack ?? b.error?.message ?? '(no error detail reported)'),
    '',
    'collected:',
  ];
  for (const item of b.items) {
    const status = item.ok ? 'OK     ' : 'MISSING';
    const detail = item.ok ? item.files.join(', ') : (item.reason ?? 'unknown reason');
    lines.push(`  [${status}] ${item.item}: ${detail}`);
    if (item.ok && item.reason) lines.push(`             partial: ${item.reason}`);
  }
  lines.push('');
  return lines.join('\n');
}


function isFailure(result: DiagnosticsTestResult): boolean {
  if (result.passed === false) return true;
  if (result.passed === true) return false;
  return !!result.error;
}

// Prefers the clause tag in the test title (`[SPEC:AND-1]` or a bare `AND-1`), else a slug of the full title.
export function deriveScenarioId(test: DiagnosticsTestInfo): string {
  const title = fullTitleOf(test);
  const tagged = /\[SPEC:([^\]]+)\]/.exec(title);
  const clause = tagged ? tagged[1].trim() : (/\b([A-Z][A-Z0-9]+-\d+[a-z]?)\b/.exec(title)?.[1] ?? '');
  const slug = slugify(title.replace(/\[SPEC:[^\]]+\]/g, ' '));
  const id = clause ? `${slugify(clause)}_${slug}` : slug;
  return (id.slice(0, 100).replace(/[-_]+$/, '') || 'unknown-scenario');
}

function fullTitleOf(test: DiagnosticsTestInfo): string {
  if (typeof test.fullTitle === 'function') {
    try {
      return test.fullTitle();
    } catch {
      /* fall through to the parent/title pair */
    }
  }
  if (typeof test.fullTitle === 'string' && test.fullTitle) return test.fullTitle;
  return [test.parent, test.title].filter(Boolean).join(' ').trim() || 'unknown test';
}

function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80);
}

// Suffixes -2, -3, ... so a re-run never overwrites a bundle.
function makeBundleDir(root: string, scenarioId: string): string {
  let candidate = join(root, scenarioId);
  for (let n = 2; existsSync(candidate) && n < 1000; n++) {
    candidate = join(root, `${scenarioId}-${n}`);
  }
  mkdirSync(candidate, { recursive: true });
  return candidate;
}

function normalizeError(error: DiagnosticsTestResult['error']): DiagnosticBundle['error'] {
  if (!error) return undefined;
  return { name: error.name, message: error.message, stack: error.stack };
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => `  ${l}`)
    .join('\n');
}

function trimTrailingSlash(p: string): string {
  return p.replace(/\/+$/, '');
}

function globalBrowser(): DiagnosticsBrowser | undefined {
  return (globalThis as { browser?: DiagnosticsBrowser }).browser;
}
