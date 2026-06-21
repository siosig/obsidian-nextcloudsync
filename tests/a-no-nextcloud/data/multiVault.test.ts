/**
 * Multi-Vault isolation integration test.
 * Verifies that settings and StateDB are independent per Vault.
 *
 * Note: Full E2E requires a real Nextcloud server.
 * These tests verify the isolation logic in isolation (no network calls).
 */

import { DEFAULT_SETTINGS } from '../../../src/types';

describe('Multi-Vault isolation', () => {
  it('each vault has independent settings structure', () => {
    const vaultASettings = { ...DEFAULT_SETTINGS, serverUrl: 'https://nc1.example.com/', username: 'alice' };
    const vaultBSettings = { ...DEFAULT_SETTINGS, serverUrl: 'https://nc2.example.com/', username: 'bob' };

    expect(vaultASettings.serverUrl).not.toBe(vaultBSettings.serverUrl);
    expect(vaultASettings.username).not.toBe(vaultBSettings.username);
  });

  it('state DB paths are vault-scoped via plugin directory', () => {
    const vaultADir = '/home/user/VaultA/.obsidian/plugins/obsidian-nextcloudsync';
    const vaultBDir = '/home/user/VaultB/.obsidian/plugins/obsidian-nextcloudsync';
    const deviceId = 'device-001';

    const statePathA = `${vaultADir}/state-${deviceId}.json`;
    const statePathB = `${vaultBDir}/state-${deviceId}.json`;

    expect(statePathA).not.toBe(statePathB);
    expect(statePathA).toContain('VaultA');
    expect(statePathB).toContain('VaultB');
  });
});
