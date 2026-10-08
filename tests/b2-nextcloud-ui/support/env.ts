// b-2 (UI) env guard. Only the live Nextcloud connection (NEXTCLOUD_*) is needed; wdio-obsidian-service
// provisions Obsidian itself. Values come from process.env only. When any are missing the suite skips,
// unless SUITE_REQUIRE_ENV=1 (set by the Docker runner), in which case it throws so a run cannot pass silently.

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
