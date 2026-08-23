// Seeds the plugin with working credentials inside the Android session.
//
// Every spec file gets its own Obsidian session, so this has to run in each one — settings applied in
// the smoke suite do not carry over. Getting this wrong is silent: the plugin simply has no
// credentials, every sync fails auth, and the symptom is "the file never arrived", which reads like a
// path-encoding bug.
//
// The password is NOT a settings field. `SettingTab.saveAppPassword` puts it in Obsidian's
// secretStorage under `settings.passwordSecretId`, and `loadAppPassword` reads it back from there.
// Writing `settings.appPassword` (which does not exist) leaves the plugin unauthenticated.
import { browser } from '@wdio/globals';

/** Must match DEFAULT_PASSWORD_SECRET_ID in src/settings/SettingTab.ts. */
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
      // Without this a failed sync is silent and the only symptom is "the file never
      // arrived", which is indistinguishable from a path-encoding bug.
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

/**
 * Reads the tail of the plugin's own debug log from inside the vault.
 *
 * Used to turn "the file never arrived" into an actual reason. Returns a short marker instead of
 * throwing when the log is absent — this is a diagnostic aid and must never become the failure.
 */
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
