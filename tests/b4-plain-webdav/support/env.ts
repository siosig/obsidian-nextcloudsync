// Connection values for the b-4 layer (plain WebDAV, no Nextcloud anywhere).
//
// Deliberately does NOT read the repository `.env` or any `NEXTCLOUD_*` key. b-4 exists to prove how
// the plugin behaves against a server that is not Nextcloud, so letting Nextcloud credentials leak in
// would let a misconfigured run silently test the wrong thing — the exact failure mode this layer was
// created to catch. The values come only from the environment that `scripts/b4-plain-webdav.sh`
// exports for the container it just started.

export interface PlainDavEnv {
  /** WebDAV collection URL of the ephemeral Apache container, e.g. http://127.0.0.1:32768/dav/ */
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

/**
 * Same shape as the b-1 `describeLive`: skip loudly rather than fail when the harness has not been
 * started, so running jest directly against this layer reports "not set up" instead of a wall of
 * connection errors that look like product bugs.
 */
export function describePlainDav(title: string, fn: (getEnv: () => PlainDavEnv) => void): void {
  const result = requirePlainDavEnv();
  if (!result.ok) {
    // eslint-disable-next-line no-console -- surface why the layer is skipped
    console.warn(`[b4] skipping "${title}": missing env ${result.missing.join(', ')} — run via \`pnpm test:b4\``);
    describe.skip(title, () => { it('skipped (harness not started)', () => undefined); });
    return;
  }
  describe(title, () => fn(() => result.env));
}

/** Basic-auth header for direct probes that bypass the plugin's clients. */
export function basicAuth(env: PlainDavEnv): string {
  return 'Basic ' + Buffer.from(`${env.username}:${env.password}`, 'utf-8').toString('base64');
}

/** A unique collection name so parallel or repeated runs never collide inside the same container. */
export function uniqueRunFolder(): string {
  return `b4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
