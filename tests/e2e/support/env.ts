// Loads live-server connection values for the E2E suite.
// Values are read ONLY at runtime from process.env or a gitignored env file.
// Nothing here is ever committed with real values.
// Named imports (not `import * as`) so no tslib __importStar helper is needed
// (tsconfig has importHelpers: true and tslib is not a dependency).
import { readFileSync } from 'fs';
import { resolve } from 'path';

export interface LiveEnv {
  /** WebDAV files endpoint (.../remote.php/dav/files/<user>[/...]). */
  serverUrl: string;
  /** Folder (relative to serverUrl) under which the isolated run folder is created. */
  syncFolder: string;
  /** Account username. */
  username: string;
  /** Nextcloud app password used as the WebDAV app password. */
  appPassword: string;
}

const REQUIRED_KEYS = ['SERVER_URL', 'SYNC_FOLDER', 'USER_NAME', 'NEXTCLOUD_TOKEN'] as const;

/** Minimal `KEY=value` / `KEY="value"` parser (no dotenv dependency). */
function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readRawValues(): Record<string, string> {
  // process.env wins; fall back to a gitignored .env file at repo root.
  const fileValues = parseEnvFile(resolve(process.cwd(), '.env'));
  const merged: Record<string, string> = { ...fileValues };
  for (const key of REQUIRED_KEYS) {
    const fromProc = process.env[key];
    if (fromProc != null && fromProc.length > 0) merged[key] = fromProc;
  }
  return merged;
}

export type LiveEnvResult =
  | { ok: true; env: LiveEnv }
  | { ok: false; missing: string[] };

/** Returns the live env config, or the list of missing required keys. */
export function requireLiveEnv(): LiveEnvResult {
  const values = readRawValues();
  const missing = REQUIRED_KEYS.filter((k) => !values[k] || values[k].length === 0);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    env: {
      serverUrl: values.SERVER_URL,
      syncFolder: values.SYNC_FOLDER,
      username: values.USER_NAME,
      appPassword: values.NEXTCLOUD_TOKEN,
    },
  };
}

/**
 * describe() that runs only when live credentials are present; otherwise skips
 * cleanly with a message naming the missing keys. The callback receives a getter
 * that returns the validated LiveEnv (safe to call inside the describe body).
 */
export function describeLive(title: string, fn: (getEnv: () => LiveEnv) => void): void {
  const result = requireLiveEnv();
  if (!result.ok) {
    // eslint-disable-next-line no-console -- surface why the live suite is skipped
    console.warn(`[e2e] skipping "${title}": missing env ${result.missing.join(', ')}`);
    describe.skip(title, () => { it('skipped (missing live env)', () => undefined); });
    return;
  }
  describe(title, () => fn(() => result.env));
}
