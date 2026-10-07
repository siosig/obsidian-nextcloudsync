// b-3 (real Android UI) env guard. b-3 needs two live things: the test Nextcloud
// (NEXTCLOUD_*, exactly like b-1/b-2) and the Redroid Android device. Both are
// described ONLY by process.env, which `bash tests/docker/run.sh b3` exports; no
// file is read and nothing is derived. When something is absent the suite must skip
// cleanly instead of throwing, so nothing here parses eagerly.

const NEXTCLOUD_REQUIRED = ['NEXTCLOUD_SERVER_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_PASSWORD'] as const;

/** CA injection into the system trust store only works up to this API level (research.md R-5). */
export const EXPECTED_ANDROID_API_LEVEL = 33;

/** The Android device (adb serial) the run targets, as exported by the runner. */
export interface AndroidDevice {
  /** `ANDROID_SERIAL`: the adb serial of the device under test. */
  serial: string;
  /** `ANDROID_API_LEVEL`: must equal EXPECTED_ANDROID_API_LEVEL for CA injection to hold. */
  apiLevel: number;
  /** `ANDROID_CA_INJECTED`: whether the test Nextcloud CA is in the device's trust store. */
  caInjected: boolean;
}

export interface AndroidEnvResult {
  /** True only when nothing is missing and nothing blocks execution. */
  ok: boolean;
  /**
   * Required keys that are not set. A non-empty `missing` means "cannot run because it is
   * not set up" -- an explicit SKIP.
   */
  missing: string[];
  /**
   * Everything needed was set, but its value makes the run impossible (wrong API level,
   * CA not injected). Kept apart from `missing` on purpose: "cannot execute" must never
   * be read as "not configured".
   */
  blocked: string[];
  /** Resolved values, shaped like env vars so a runner can export them verbatim. */
  values: Record<string, string>;
  /** Parsed device facts; undefined when any of the device keys is missing or malformed. */
  device?: AndroidDevice;
}

/**
 * Resolves everything b-3 needs from process.env. Never throws: absent keys are reported
 * through `missing` so the caller can decide to SKIP, while values that rule out a run are
 * reported through `blocked`.
 */
export function requireAndroidEnv(): AndroidEnvResult {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const blocked: string[] = [];

  for (const k of NEXTCLOUD_REQUIRED) {
    const v = process.env[k];
    if (v) values[k] = v;
    else missing.push(k);
  }

  const serial = process.env.ANDROID_SERIAL;
  const apiLevelRaw = process.env.ANDROID_API_LEVEL;
  const caRaw = process.env.ANDROID_CA_INJECTED;

  if (serial) values.ANDROID_SERIAL = serial;
  else missing.push('ANDROID_SERIAL');

  let apiLevel: number | undefined;
  if (apiLevelRaw) {
    values.ANDROID_API_LEVEL = apiLevelRaw;
    const parsed = Number.parseInt(apiLevelRaw, 10);
    if (Number.isNaN(parsed)) {
      blocked.push(`ANDROID_API_LEVEL is not a number (${apiLevelRaw}), expected ${EXPECTED_ANDROID_API_LEVEL}`);
    } else {
      apiLevel = parsed;
      if (parsed !== EXPECTED_ANDROID_API_LEVEL) {
        blocked.push(
          `ANDROID_API_LEVEL is ${parsed}, expected ${EXPECTED_ANDROID_API_LEVEL}: ` +
            'CA injection into the system trust store does not hold on other levels',
        );
      }
    }
  } else {
    missing.push('ANDROID_API_LEVEL');
  }

  let caInjected: boolean | undefined;
  if (caRaw) {
    values.ANDROID_CA_INJECTED = caRaw;
    caInjected = caRaw === 'true';
    if (!caInjected) blocked.push('ANDROID_CA_INJECTED is not true: TLS to the test server will fail');
  } else {
    missing.push('ANDROID_CA_INJECTED');
  }

  const device: AndroidDevice | undefined =
    serial && apiLevel !== undefined && caInjected !== undefined ? { serial, apiLevel, caInjected } : undefined;

  return { ok: missing.length === 0 && blocked.length === 0, missing, blocked, values, device };
}

/**
 * Gate for a scenario's `before` hook.
 *
 * Locally an unusable environment is a skip. On a real run it is NOT: run.sh sets
 * SUITE_REQUIRE_ENV=1, and then a scenario that cannot assert anything must FAIL rather than skip,
 * because wdio exits 0 on an all-skipped run and the release gate would read that as a pass. A green
 * run that asserted nothing is the exact failure mode this layer exists to prevent.
 */
export function requireEnvOrSkip(ctx: { skip: () => void }): AndroidEnvResult {
  const env = requireAndroidEnv();
  if (env.ok) return env;
  const detail = [...env.missing.map((m) => `missing: ${m}`), ...env.blocked.map((b) => `blocked: ${b}`)].join('; ');
  if (process.env.SUITE_REQUIRE_ENV === '1') {
    throw new Error(`b-3 environment is not usable, refusing to skip on a real run — ${detail}`);
  }
  ctx.skip();
  return env;
}
