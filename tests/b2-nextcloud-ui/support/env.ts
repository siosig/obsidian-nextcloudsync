// b-2 (UI) env guard. wdio-obsidian-service downloads & launches Obsidian itself
// (no Obsidian account login needed), so b-2 only needs the live Nextcloud
// connection (NEXTCLOUD_*) for the plugin to talk to the server. When any are
// missing the suite must skip cleanly.
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REQUIRED = ['NEXTCLOUD_SERVER_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_PASSWORD'] as const;

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

export interface UiEnvResult {
  ok: boolean;
  missing: string[];
  values: Record<string, string>;
}

export function requireUiEnv(): UiEnvResult {
  const file = parseEnvFile(resolve(process.cwd(), '.env'));
  const values: Record<string, string> = { ...file };
  for (const k of REQUIRED) {
    const p = process.env[k];
    if (p) values[k] = p;
  }
  const missing = REQUIRED.filter((k) => !values[k]);
  return { ok: missing.length === 0, missing, values };
}
