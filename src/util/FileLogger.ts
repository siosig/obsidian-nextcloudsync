import { DataAdapter, normalizePath } from 'obsidian';
import { ensureParentFolder } from './ensureParentFolder';

/** Debug-log verbosity levels, ordered least → most verbose. */
export type DebugLogLevel = 'error' | 'debug' | 'verbose';

const LEVEL_RANK: Record<DebugLogLevel, number> = { error: 0, debug: 1, verbose: 2 };

/**
 * Appends timestamped diagnostic lines to a per-device markdown file (named with this device's
 * host token, inside the chosen log folder). Active only while {@link isEnabled} returns true and
 * the call's level passes the configured threshold (a call writes iff `configured >= call`).
 *
 * Each line records the fire time (ISO 8601), the host token (so lines from different devices are
 * distinguishable), the plugin version, then the message, e.g.
 * `- 2026-06-09T07:12:00.000Z  [desktop-a1b2c3]  v0.2.10  login: button clicked`.
 *
 * Writing never throws: diagnostic logging must not break the operation it instruments.
 */
export class FileLogger {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly isEnabled: () => boolean,
    private readonly level: () => DebugLogLevel,
    private readonly appVersion: string,
    private readonly host: string,
    private readonly pathOf: () => string,
  ) {}

  /**
   * Append one diagnostic line at the given level (default `debug`). No-op when logging is
   * disabled or the level is below the configured threshold. Best-effort (swallows errors).
   */
  async log(message: string, level: DebugLogLevel = 'debug'): Promise<void> {
    if (!this.isEnabled()) return;
    if (LEVEL_RANK[level] > LEVEL_RANK[this.level()]) return;
    const line = `- ${new Date().toISOString()}  [${this.host}]  v${this.appVersion}  ${message}\n`;
    try {
      const p = normalizePath(this.pathOf());
      if (await this.adapter.exists(p)) {
        await this.adapter.append(p, line);
      } else {
        await ensureParentFolder(this.adapter, p);
        await this.adapter.write(p, `# Nextcloud Sync — diagnostic log\n\n${line}`);
      }
    } catch {
      // Never let diagnostic logging interfere with the flow being logged.
    }
  }
}
