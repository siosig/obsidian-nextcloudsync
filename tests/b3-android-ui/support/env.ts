// b-3 (real Android UI) env guard. b-3 needs two live things: the test Nextcloud
// (NEXTCLOUD_*, exactly like b-1/b-2) and the AVD host instance that runs the
// emulator. Both are resolved from sources that already exist -- no b-3 specific
// setting is introduced (FR-009). When something is absent the suite must skip
// cleanly instead of throwing, so nothing here reads or parses eagerly.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, resolve } from 'path';

const NEXTCLOUD_REQUIRED = ['NEXTCLOUD_SERVER_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_PASSWORD'] as const;

/** CA injection into the system trust store only works up to this API level (research.md R-5). */
export const EXPECTED_ANDROID_API_LEVEL = 33;

/** Default location of the AVD host instance repo; overridable with ANDROID_INSTANCE_DIR. */
const DEFAULT_ANDROID_INSTANCE_DIR = 'workspace/siosig/android-testinstance';
/** Default location of the Nextcloud test instance repo; same INSTANCE_DIR that b1-cluster.sh uses. */
const DEFAULT_NEXTCLOUD_INSTANCE_DIR = 'workspace/siosig/nextcloud-testinstance';

function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/** Reads a JSON object, returning null when the file is absent or unparsable. */
function readJsonObject(filePath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Expands a leading `~` and makes the path absolute against the home directory. */
function expandDir(dir: string): string {
  if (dir.startsWith('~/')) return resolve(homedir(), dir.slice(2));
  if (dir === '~') return homedir();
  return isAbsolute(dir) ? dir : resolve(homedir(), dir);
}

/** Instance directory of the AVD host (ANDROID_INSTANCE_DIR, else the default checkout path). */
export function androidInstanceDir(): string {
  return expandDir(process.env.ANDROID_INSTANCE_DIR || DEFAULT_ANDROID_INSTANCE_DIR);
}

/** Instance directory of the Nextcloud test instance (INSTANCE_DIR, as in b1-cluster.sh). */
export function nextcloudInstanceDir(): string {
  return expandDir(process.env.INSTANCE_DIR || process.env.CLUSTER_DIR || DEFAULT_NEXTCLOUD_INSTANCE_DIR);
}

/** Connection file written by the AVD host instance's `up` (contracts/avd-host-instance.md). */
export function androidConnectionPath(): string {
  return resolve(androidInstanceDir(), '.run/connection.json');
}

/** Connection file written by the Nextcloud test instance's `up` (read by b1-cluster.sh). */
export function nextcloudConnectionPath(): string {
  return resolve(nextcloudInstanceDir(), '.run/connection.json');
}

/** AVD host connection, as published in the instance's `.run/connection.json`. */
export interface AndroidHostConnection {
  /** `run_id`: identifies the run's cloud resources, used for leftover cleanup. */
  runId: string;
  /** `ssh_target`: SSH destination used to drive the emulator and pull diagnostics. */
  sshTarget: string;
  /** `android_api_level`: must equal EXPECTED_ANDROID_API_LEVEL for CA injection to hold. */
  apiLevel: number;
  /** `ca_injected`: whether the test Nextcloud CA is in the emulator's trust store. */
  caInjected: boolean;
  /** `ready`: the same readiness verdict that `status` reports. */
  ready: boolean;
}

export interface AndroidEnvResult {
  /** True only when nothing is missing and nothing blocks execution. */
  ok: boolean;
  /**
   * Configuration/connection data that could not be found at all. A non-empty
   * `missing` means "cannot run because it is not set up" -- an explicit SKIP.
   */
  missing: string[];
  /**
   * Everything needed was found, but its value makes the run impossible
   * (wrong API level, CA not injected, host not ready). Kept apart from
   * `missing` on purpose: "cannot execute" must never be read as "not configured".
   */
  blocked: string[];
  /** Resolved values, shaped like env vars so a runner can export them verbatim. */
  values: Record<string, string>;
  /** Parsed AVD host connection; undefined when the file or its fields are missing. */
  host?: AndroidHostConnection;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v ? v : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function readBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return undefined;
}

/**
 * Resolves everything b-3 needs. Never throws: absent files and absent fields are
 * reported through `missing` so the caller can decide to SKIP, while values that
 * rule out a run are reported through `blocked`.
 *
 * Nextcloud precedence: process.env > repo-root .env > the Nextcloud instance's
 * connection.json (the same file b1-cluster.sh reads).
 */

/**
 * Reads the AVD host facts from the environment, as forwarded by scripts/b3-android.sh. Returns
 * undefined unless the full set is present, so a partial environment falls back to the file rather
 * than silently reporting a half-known host.
 */
function readHostFromEnv(): AndroidHostConnection | undefined {
  const runId = process.env.ANDROID_RUN_ID;
  const sshTarget = process.env.ANDROID_SSH_TARGET;
  const apiLevelRaw = process.env.ANDROID_API_LEVEL;
  const caInjected = process.env.ANDROID_CA_INJECTED;
  const ready = process.env.ANDROID_READY;
  if (!runId || !sshTarget || !apiLevelRaw || !caInjected || !ready) return undefined;
  const apiLevel = Number.parseInt(apiLevelRaw, 10);
  if (Number.isNaN(apiLevel)) return undefined;
  return { runId, sshTarget, apiLevel, caInjected: caInjected === 'true', ready: ready === 'true' };
}

export function requireAndroidEnv(): AndroidEnvResult {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const blocked: string[] = [];

  // --- Nextcloud side -------------------------------------------------------
  const file = parseEnvFile(resolve(process.cwd(), '.env'));
  for (const k of NEXTCLOUD_REQUIRED) if (file[k]) values[k] = file[k];
  for (const k of NEXTCLOUD_REQUIRED) {
    const p = process.env[k];
    if (p) values[k] = p;
  }
  // Fall back to the live instance's connection file; its external IP changes on
  // every `make up`, so this keeps b-3 following the current instance with no edit.
  const ncConnPath = nextcloudConnectionPath();
  const ncConn = NEXTCLOUD_REQUIRED.every((k) => values[k]) ? null : readJsonObject(ncConnPath);
  if (ncConn) {
    const fromConn: Record<(typeof NEXTCLOUD_REQUIRED)[number], string | undefined> = {
      NEXTCLOUD_SERVER_URL: readString(ncConn, 'dav_base_url'),
      NEXTCLOUD_USER: readString(ncConn, 'admin_user'),
      NEXTCLOUD_PASSWORD: readString(ncConn, 'admin_password'),
    };
    for (const k of NEXTCLOUD_REQUIRED) {
      const v = fromConn[k];
      if (!values[k] && v) values[k] = v;
    }
  }
  for (const k of NEXTCLOUD_REQUIRED) if (!values[k]) missing.push(k);

  // --- AVD host side --------------------------------------------------------
  const androidConnPath = androidConnectionPath();
  values.ANDROID_INSTANCE_DIR = androidInstanceDir();
  // The harness runs ON the AVD host, where the instance repo (and therefore connection.json) does
  // not exist. The runner forwards the same facts as environment variables, so prefer those and fall
  // back to the file for a local invocation. Without this, every scenario skipped its way to a green
  // run on the device itself — a pass that asserted nothing.
  const envHost = readHostFromEnv();
  const conn = envHost ? null : readJsonObject(androidConnPath);
  let host: AndroidHostConnection | undefined;
  if (envHost) {
    host = envHost;
    values.ANDROID_RUN_ID = envHost.runId;
    values.ANDROID_SSH_TARGET = envHost.sshTarget;
    values.ANDROID_API_LEVEL = String(envHost.apiLevel);
    if (envHost.apiLevel !== EXPECTED_ANDROID_API_LEVEL) {
      blocked.push(
        `ANDROID_API_LEVEL is ${envHost.apiLevel}, expected ${EXPECTED_ANDROID_API_LEVEL}: ` +
          'CA injection into the system trust store does not hold on other levels',
      );
    }
    if (!envHost.caInjected) blocked.push('ANDROID_CA_INJECTED is not true: TLS to the test server will fail');
    if (!envHost.ready) blocked.push('ANDROID_READY is not true: the runtime is not usable');
  } else if (!conn) {
    missing.push(`android connection.json (${androidConnPath})`);
  } else {
    const runId = readString(conn, 'run_id');
    const sshTarget = readString(conn, 'ssh_target');
    const apiLevel = readNumber(conn, 'android_api_level');
    const caInjected = readBoolean(conn, 'ca_injected');
    const ready = readBoolean(conn, 'ready');

    if (runId === undefined) missing.push('android connection.json: run_id');
    if (sshTarget === undefined) missing.push('android connection.json: ssh_target');
    if (apiLevel === undefined) missing.push('android connection.json: android_api_level');
    if (caInjected === undefined) missing.push('android connection.json: ca_injected');
    if (ready === undefined) missing.push('android connection.json: ready');

    if (
      runId !== undefined &&
      sshTarget !== undefined &&
      apiLevel !== undefined &&
      caInjected !== undefined &&
      ready !== undefined
    ) {
      host = { runId, sshTarget, apiLevel, caInjected, ready };
      values.ANDROID_RUN_ID = runId;
      values.ANDROID_SSH_TARGET = sshTarget;
      values.ANDROID_API_LEVEL = String(apiLevel);

      // Present but unusable -> blocked, not missing.
      if (apiLevel !== EXPECTED_ANDROID_API_LEVEL) {
        blocked.push(
          `android_api_level is ${apiLevel}, expected ${EXPECTED_ANDROID_API_LEVEL}: ` +
            'CA injection into the system trust store does not hold on other levels',
        );
      }
      if (!caInjected) blocked.push('ca_injected is false: the test Nextcloud CA is not in the emulator trust store');
      if (!ready) blocked.push('ready is false: the AVD host instance has not finished provisioning');
    }
  }

  return { ok: missing.length === 0 && blocked.length === 0, missing, blocked, values, host };
}

/**
 * Gate for a scenario's `before` hook.
 *
 * Locally an unusable environment is a skip. On a real run it is NOT: the runner sets
 * B3_REQUIRE_ENV=1, and then a scenario that cannot assert anything must FAIL rather than skip,
 * because wdio exits 0 on an all-skipped run and the release gate would read that as a pass. A green
 * run that asserted nothing is the exact failure mode this layer exists to prevent.
 */
export function requireEnvOrSkip(ctx: { skip: () => void }): AndroidEnvResult {
  const env = requireAndroidEnv();
  if (env.ok) return env;
  const detail = [...env.missing.map((m) => `missing: ${m}`), ...env.blocked.map((b) => `blocked: ${b}`)].join('; ');
  if (process.env.B3_REQUIRE_ENV === '1') {
    throw new Error(`b-3 environment is not usable, refusing to skip on a real run — ${detail}`);
  }
  ctx.skip();
  return env;
}
