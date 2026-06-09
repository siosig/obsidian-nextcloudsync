import { DataAdapter, normalizePath } from 'obsidian';

/** Vault-root file the diagnostic log is appended to. Synced like any other note. */
export const DEBUG_LOG_PATH = 'nextcloud-sync-debug.md';

/**
 * Appends timestamped diagnostic lines to a markdown file at the vault root.
 * Active only while {@link isEnabled} returns true (wired to Debug mode), on all platforms.
 *
 * Each line records at least the fire time (ISO 8601) and the plugin version, then the message,
 * e.g. `- 2026-06-09T07:12:00.000Z  v0.2.1-beta.2  login: button clicked`.
 *
 * Writing never throws: diagnostic logging must not break the operation it instruments.
 */
export class FileLogger {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly isEnabled: () => boolean,
    private readonly appVersion: string,
    private readonly path: string = DEBUG_LOG_PATH,
  ) {}

  /** Append one diagnostic line. No-op when logging is disabled. Best-effort (swallows errors). */
  async log(message: string): Promise<void> {
    if (!this.isEnabled()) return;
    const line = `- ${new Date().toISOString()}  v${this.appVersion}  ${message}\n`;
    try {
      const p = normalizePath(this.path);
      if (await this.adapter.exists(p)) {
        await this.adapter.append(p, line);
      } else {
        await this.adapter.write(p, `# Nextcloud Sync — diagnostic log\n\n${line}`);
      }
    } catch {
      // Never let diagnostic logging interfere with the flow being logged.
    }
  }
}
