// b-2 (UI) env guard. wdio-obsidian-service downloads & launches Obsidian itself
// (no Obsidian account login needed), so b-2 only needs the live Nextcloud
// connection (NEXTCLOUD_*) for the plugin to talk to the server.
// Values are read from process.env only (no .env file). When any are missing the
// suite skips cleanly, unless SUITE_REQUIRE_ENV=1 (set by the Docker runner), in
// which case it throws so that a misconfigured run can never pass silently.

const REQUIRED = ['NEXTCLOUD_SERVER_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_PASSWORD'] as const;

export interface UiEnvResult {
  ok: boolean;
  missing: string[];
  values: Record<string, string>;
}

export function requireUiEnv(): UiEnvResult {
  const values: Record<string, string> = {};
  for (const k of REQUIRED) {
    const p = process.env[k];
    if (p) values[k] = p;
  }
  const missing = REQUIRED.filter((k) => !values[k]);
  if (missing.length > 0 && process.env.SUITE_REQUIRE_ENV === '1') {
    throw new Error(`[b-2] SUITE_REQUIRE_ENV=1 but required env is missing: ${missing.join(', ')}`);
  }
  return { ok: missing.length === 0, missing, values };
}
