import { DataAdapter, normalizePath } from 'obsidian';
import { ensureParentFolder } from './ensureParentFolder';

export type DebugLogLevel = 'error' | 'debug' | 'verbose';

const LEVEL_RANK: Record<DebugLogLevel, number> = { error: 0, debug: 1, verbose: 2 };

// Line format: `- 2026-06-09T07:12:00.000Z  [desktop-a1b2c3]  v0.2.10  login: button clicked`.
// A call writes iff the configured level >= the call's level. Writing never throws: diagnostic
// logging must not break the operation it instruments.
export class FileLogger {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly isEnabled: () => boolean,
    private readonly level: () => DebugLogLevel,
    private readonly appVersion: string,
    private readonly host: string,
    private readonly pathOf: () => string,
    // Notified when a write fails; the host surfaces it as a Notice so "logging is on but no file
    // appears" is not silent.
    private readonly onWriteError?: (err: unknown) => void,
  ) {}

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
    } catch (err) {
      // Do not rethrow; report through onWriteError instead.
      this.onWriteError?.(err);
    }
  }
}
