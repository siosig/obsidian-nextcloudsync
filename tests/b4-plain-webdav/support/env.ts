// Connection values for the b-4 layer (plain WebDAV, no Nextcloud). Deliberately does NOT read the repository `.env`
// or any `NEXTCLOUD_*` key, so a misconfigured run cannot silently test the wrong server. Values come only from the
// environment exported by `scripts/b4-plain-webdav.sh` for the container it started (`bash tests/docker/run.sh b4`).

export interface PlainDavEnv {
  // WebDAV collection URL of the ephemeral Apache container, e.g. http://127.0.0.1:32768/dav/
  serverUrl: string;
  username: string;
  password: string;
}

const REQUIRED_KEYS = ['B4_SERVER_URL', 'B4_USER', 'B4_PASSWORD'] as const;

type EnvResult = { ok: true; env: PlainDavEnv } | { ok: false; missing: string[] };

function requirePlainDavEnv(): EnvResult {
  const missing = REQUIRED_KEYS.filter((k) => !process.env[k]);
  if (missing.length > 0) return { ok: false, missing: [...missing] };
  return {
    ok: true,
    env: {
      serverUrl: process.env.B4_SERVER_URL as string,
      username: process.env.B4_USER as string,
      password: process.env.B4_PASSWORD as string,
    },
  };
}

// Skips loudly rather than failing when the harness is not started, so running jest directly reports "not set up"
// instead of a wall of connection errors that look like product bugs.
export function describePlainDav(title: string, fn: (getEnv: () => PlainDavEnv) => void): void {
  const result = requirePlainDavEnv();
  if (!result.ok) {
    // Under the Docker suite runner the env is mandatory: a missing key must fail, never skip.
    if (process.env.SUITE_REQUIRE_ENV === '1') {
      describe(title, () => {
        it('requires the b-4 harness env', () => {
          throw new Error(`[b4] missing required env: ${result.missing.join(', ')}`);
        });
      });
      return;
    }
    // eslint-disable-next-line no-console -- surface why the layer is skipped
    console.warn(`[b4] skipping "${title}": missing env ${result.missing.join(', ')} — run via \`bash tests/docker/run.sh b4\``);
    describe.skip(title, () => { it('skipped (harness not started)', () => undefined); });
    return;
  }
  describe(title, () => fn(() => result.env));
}

// For direct probes that bypass the plugin's clients.
export function basicAuth(env: PlainDavEnv): string {
  return 'Basic ' + Buffer.from(`${env.username}:${env.password}`, 'utf-8').toString('base64');
}

// Unique so parallel or repeated runs never collide inside the same container.
export function uniqueRunFolder(): string {
  return `b4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
