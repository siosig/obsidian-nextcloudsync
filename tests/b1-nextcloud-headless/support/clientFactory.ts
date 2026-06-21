// Builds NextcloudClient instances and DavSyncSettings for E2E tests.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DavSyncSettings, DEFAULT_SETTINGS } from '../../../src/types';
import { LiveEnv } from './env';

/** DavSyncSettings = defaults + live connection values + per-test overrides. */
export function makeSettings(env: LiveEnv, overrides: Partial<DavSyncSettings> = {}): DavSyncSettings {
  const rand = Math.random().toString(36).slice(2, 10);
  return {
    ...DEFAULT_SETTINGS,
    serverUrl: env.serverUrl,
    username: env.username,
    // deviceId is sliced (-8) for chunk upload session ids; keep it long enough.
    deviceId: `e2edev${rand}`,
    ...overrides,
  };
}

/** A NextcloudClient scoped to `remoteBase`, with optional settings overrides. */
export function makeClient(
  env: LiveEnv,
  remoteBase: string,
  overrides?: Partial<DavSyncSettings>,
): NextcloudClient {
  return new NextcloudClient(makeSettings(env, overrides), env.appPassword, remoteBase);
}

/** Base URL (trailing slash stripped) — mirrors NextcloudClient's own derivation. */
export function baseUrlOf(env: LiveEnv): string {
  return env.serverUrl.replace(/\/$/, '');
}

/** HTTP Basic auth header for the live account (for ensureRemoteDir in tests). */
export function authHeaderOf(env: LiveEnv): string {
  const creds = `${env.username}:${env.appPassword}`;
  return `Basic ${Buffer.from(creds, 'utf-8').toString('base64')}`;
}
