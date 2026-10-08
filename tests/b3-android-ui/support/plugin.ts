// Seeds the plugin with working credentials inside the Android session. Every spec file gets its own Obsidian
// session, so this runs in each one; missing credentials fail silently as "the file never arrived".
// The password is not a settings field: `SettingTab.saveAppPassword` stores it in Obsidian's secretStorage under
// `settings.passwordSecretId`, and `loadAppPassword` reads it back from there.
import { browser } from '@wdio/globals';

// Must match DEFAULT_PASSWORD_SECRET_ID in src/settings/SettingTab.ts.
export const PASSWORD_SECRET_ID = 'obsidian-nextcloudsync-password';

export async function seedConnection(
  serverUrl: string,
  user: string,
  password: string,
): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, server: string, username: string, pw: string, secretId: string) => {
      const plugin = (app as any).plugins.plugins['nextcloud-sync'];
      if (!plugin) throw new Error('the nextcloud-sync plugin is not loaded');
      (app as any).secretStorage.setSecret(secretId, pw);
      plugin.settings.serverUrl = server;
      plugin.settings.username = username;
      plugin.settings.passwordSecretId = secretId;
      // Without this a failed sync is silent and looks like a path-encoding bug.
      plugin.settings.loggingEnabled = true;
      await plugin.saveSettings?.();
      // Rebuild the client so it picks up the credentials we just stored.
      await plugin.initSyncEngine?.();
    },
    serverUrl,
    user,
    password,
    PASSWORD_SECRET_ID,
  );
}

// Turns "the file never arrived" into a reason. Returns a marker instead of throwing when the log is absent.
export async function pluginLogTail(lines = 40): Promise<string> {
  try {
    const text = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins['nextcloud-sync'];
      const folder = plugin?.settings?.logsFolder ?? '';
      const listing = await app.vault.adapter.list(folder || '/');
      const log = (listing.files as string[]).find((f) => /nextcloud-debug_.*\.txt$/.test(f));
      return log ? await app.vault.adapter.read(log) : null;
    });
    if (!text) return '(no plugin debug log found)';
    return (text as string).split('\n').slice(-lines).join('\n');
  } catch (e) {
    return `(could not read plugin debug log: ${(e as Error).message})`;
  }
}
