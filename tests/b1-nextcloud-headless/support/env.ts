// Loads live-server connection values for the b-1 (headless) suite.
// Values are read ONLY at runtime from process.env, which the Docker suite runner
// (`bash tests/docker/run.sh b1`) injects. No env file is ever read.
// Nothing here is ever committed with real values.

export interface LiveEnv {
  /** WebDAV files endpoint (.../remote.php/dav/files/<user>[/...]). */
  serverUrl: string;
  /** Folder (relative to serverUrl) under which the isolated run folder is created. */
  syncFolder: string;
  /** Account username. */
  username: string;
  /** Nextcloud app password used as the WebDAV app password. */
  appPassword: string;
  /** Optional second account (for share/lock tests); set only when all 3 user2 keys are present. */
  user2?: { serverUrl: string; username: string; password: string };
}

// NEXTCLOUD_VAULT_NAME is OPTIONAL (empty => operate under the SERVER_URL root —
// i.e. the "no vault configured yet" initial state).
const REQUIRED_KEYS = ['NEXTCLOUD_SERVER_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_PASSWORD'] as const;

function envValue(key: string): string | undefined {
  const v = process.env[key];
  return v != null && v.length > 0 ? v : undefined;
}

/** When SUITE_REQUIRE_ENV=1, missing env must fail the run instead of skipping. */
function requireEnvMode(): boolean {
  return process.env.SUITE_REQUIRE_ENV === '1';
}

export type LiveEnvResult =
  | { ok: true; env: LiveEnv }
  | { ok: false; missing: string[] };

/** Returns the live env config, or the list of missing required keys. */
export function requireLiveEnv(): LiveEnvResult {
  const missing = REQUIRED_KEYS.filter((k) => !envValue(k));
  if (missing.length > 0) return { ok: false, missing };

  const url2 = envValue('NEXTCLOUD_SERVER_URL2');
  const user2 = envValue('NEXTCLOUD_USER2');
  const pass2 = envValue('NEXTCLOUD_PASSWORD2');
  return {
    ok: true,
    env: {
      serverUrl: envValue('NEXTCLOUD_SERVER_URL')!,
      // The Vault name is the top remote folder; tests isolate into a unique
      // subfolder beneath it (NEXTCLOUD_VAULT_NAME/e2e-<ts>). Empty/unset =>
      // isolate directly under the SERVER_URL root (no-vault initial state).
      syncFolder: process.env.NEXTCLOUD_VAULT_NAME ?? '',
      username: envValue('NEXTCLOUD_USER')!,
      appPassword: envValue('NEXTCLOUD_PASSWORD')!,
      ...(url2 && user2 && pass2 ? { user2: { serverUrl: url2, username: user2, password: pass2 } } : {}),
    },
  };
}

/** Returns the second account, or throws when its env keys were not provided. */
export function requireUser2(env: LiveEnv): NonNullable<LiveEnv['user2']> {
  if (!env.user2) {
    throw new Error(
      'second Nextcloud account (NEXTCLOUD_USER2/NEXTCLOUD_PASSWORD2/NEXTCLOUD_SERVER_URL2) is required',
    );
  }
  return env.user2;
}

/**
 * Registers a describe() containing one failing test that lists the missing keys.
 * Used in SUITE_REQUIRE_ENV=1 mode so a missing environment is a visible failure, never a skip.
 */
function describeMissingEnv(title: string, missing: string[]): void {
  describe(title, () => {
    it('requires the suite environment', () => {
      throw new Error(`missing env: ${missing.join(', ')}`);
    });
  });
}

/**
 * describe() that runs only when live credentials are present; otherwise skips
 * cleanly with a message naming the missing keys (or fails when SUITE_REQUIRE_ENV=1).
 * The callback receives a getter that returns the validated LiveEnv (safe to call
 * inside the describe body).
 */
export function describeLive(title: string, fn: (getEnv: () => LiveEnv) => void): void {
  const result = requireLiveEnv();
  if (!result.ok) {
    if (requireEnvMode()) {
      describeMissingEnv(title, result.missing);
      return;
    }
    // eslint-disable-next-line no-console -- surface why the live suite is skipped
    console.warn(`[e2e] skipping "${title}": missing env ${result.missing.join(', ')}`);
    describe.skip(title, () => { it('skipped (missing live env)', () => undefined); });
    return;
  }
  describe(title, () => fn(() => result.env));
}

// The "N" actor (feature 051) — a change made DIRECTLY on the Nextcloud server FS — is reached over
// HTTP through the nc-fsops sidecar of the Docker suite (`bash tests/docker/run.sh b1`), which
// exports NEXTCLOUD_FSOPS_URL. NEXTCLOUD_USER is already a live-env key, so N needs only this URL.
const CLUSTER_KEYS = ['NEXTCLOUD_FSOPS_URL'] as const;

/** Which cluster-only (N actor) keys are missing from process.env, if any. */
export function missingClusterKeys(): string[] {
  return CLUSTER_KEYS.filter((k) => !envValue(k));
}

/**
 * describe() for the 3-actor (feature 051) suites, which need BOTH live WebDAV credentials AND the
 * N actor (nc-fsops HTTP endpoint). Runs only when both are present; otherwise skips CLEANLY
 * (visible in the report as "skipped", never a silent pass) — or fails when SUITE_REQUIRE_ENV=1.
 * `bash tests/docker/run.sh b1` provides the full environment so they run.
 */
export function describeCluster(title: string, fn: (getEnv: () => LiveEnv) => void): void {
  const live = requireLiveEnv();
  const missingCluster = missingClusterKeys();
  if (!live.ok || missingCluster.length > 0) {
    const missing = [...(live.ok ? [] : live.missing), ...missingCluster];
    if (requireEnvMode()) {
      describeMissingEnv(title, missing);
      return;
    }
    // eslint-disable-next-line no-console -- surface why the cluster suite is skipped
    console.warn(`[e2e] skipping "${title}": cluster N unavailable (missing ${missing.join(', ')})`);
    describe.skip(title, () => {
      it('skipped (cluster N unavailable — run `bash tests/docker/run.sh b1`)', () => undefined);
    });
    return;
  }
  describe(title, () => fn(() => live.env));
}
