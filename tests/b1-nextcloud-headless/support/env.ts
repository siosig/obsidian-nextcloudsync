// Live-server connection values for the b1 suite, read only from process.env (injected by
// `bash tests/docker/run.sh b1`). No env file is read.

export interface LiveEnv {
  /** WebDAV files endpoint (.../remote.php/dav/files/<user>[/...]). */
  serverUrl: string;
  syncFolder: string;
  username: string;
  appPassword: string;
  /** Optional second account (for share/lock tests); set only when all 3 user2 keys are present. */
  user2?: { serverUrl: string; username: string; password: string };
}

// NEXTCLOUD_VAULT_NAME is optional: empty means operate under the SERVER_URL root (the "no vault configured yet" state).
const REQUIRED_KEYS = ['NEXTCLOUD_SERVER_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_PASSWORD'] as const;

function envValue(key: string): string | undefined {
  const v = process.env[key];
  return v != null && v.length > 0 ? v : undefined;
}

function requireEnvMode(): boolean {
  return process.env.SUITE_REQUIRE_ENV === '1';
}

export type LiveEnvResult =
  | { ok: true; env: LiveEnv }
  | { ok: false; missing: string[] };

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
      // The vault name is the top remote folder; tests isolate into a unique subfolder beneath it.
      syncFolder: process.env.NEXTCLOUD_VAULT_NAME ?? '',
      username: envValue('NEXTCLOUD_USER')!,
      appPassword: envValue('NEXTCLOUD_PASSWORD')!,
      ...(url2 && user2 && pass2 ? { user2: { serverUrl: url2, username: user2, password: pass2 } } : {}),
    },
  };
}

export function requireUser2(env: LiveEnv): NonNullable<LiveEnv['user2']> {
  if (!env.user2) {
    throw new Error(
      'second Nextcloud account (NEXTCLOUD_USER2/NEXTCLOUD_PASSWORD2/NEXTCLOUD_SERVER_URL2) is required',
    );
  }
  return env.user2;
}

// Fails visibly when SUITE_REQUIRE_ENV=1 and the environment is missing, instead of skipping.
function describeMissingEnv(title: string, missing: string[]): void {
  describe(title, () => {
    it('requires the suite environment', () => {
      throw new Error(`missing env: ${missing.join(', ')}`);
    });
  });
}

// Runs only when live credentials are present; otherwise skips with a message naming the missing keys
// (or fails when SUITE_REQUIRE_ENV=1).
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

// The "N" actor (a change made directly on the Nextcloud server FS) is reached over HTTP through the
// nc-fsops sidecar, which exports NEXTCLOUD_FSOPS_URL.
const CLUSTER_KEYS = ['NEXTCLOUD_FSOPS_URL'] as const;

export function missingClusterKeys(): string[] {
  return CLUSTER_KEYS.filter((k) => !envValue(k));
}

// Like describeLive, but also requires the N actor (nc-fsops endpoint); skips visibly, never as a silent pass.
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
