// Turns a session's over-the-size-limit skip tally into one notice at the end of a manual sync
// (docs/spec.md §9.4a). Recording the skips is SyncJournal's job; this class only reports the total.
import type { FileLogger } from '../../util/FileLogger';
import type { SyncSessionSummary, SyncTrigger } from '../../types';

/** Display time of the skip-count notice, the same as the community-plugin notices. */
export const OVERSIZE_SKIP_NOTICE_MS = 8000;

/** The notice text for `count` (≥ 1) files skipped while the limit is `limitMB` (docs/spec.md §9.4a). */
export function oversizeSkipNoticeText(count: number, limitMB: number): string {
  const noun = count === 1 ? 'file' : 'files';
  const pronoun = count === 1 ? 'it' : 'them';
  if (limitMB > 0) {
    return `⚠️ Skipped ${count} ${noun} over the ${limitMB} MB size limit. Raise "Maximum file size (MB)" and sync again to include ${pronoun}.`;
  }
  return `⚠️ Skipped ${count} ${noun} over the size limit. Sync again to include ${pronoun}.`;
}

export interface OversizeSkipNotifierDeps {
  /** Read at finish time so the notice shows the current limit. */
  maxFileSizeMB(): number;
  notify(message: string, timeout: number): void;
  logger?: Pick<FileLogger, 'log'>;
}

export class OversizeSkipNotifier {
  constructor(private readonly deps: OversizeSkipNotifierDeps) {}

  /**
   * The single place that turns a session's skip tally into a notice: one notice after a manual session
   * with at least one skip, nothing otherwise. Never throws (docs/spec.md §9.4a).
   */
  sessionFinished(summary: SyncSessionSummary, trigger: SyncTrigger): void {
    try {
      const count = summary.oversizeSkippedPaths.size;
      if (count === 0) return;
      if (trigger === 'manual') {
        try {
          this.deps.notify(oversizeSkipNoticeText(count, this.deps.maxFileSizeMB()), OVERSIZE_SKIP_NOTICE_MS);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log(`size-limit: notice failed — ${message}`, 'error');
        }
      }
      this.log(`size-limit: session total=${count} trigger=${trigger} notice=${trigger === 'manual' ? 'shown' : 'suppressed'}`);
    } catch {
      /* A skip report must never affect a sync. */
    }
  }

  private log(message: string, level?: 'error'): void {
    try {
      void Promise.resolve(level ? this.deps.logger?.log(message, level) : this.deps.logger?.log(message)).catch(() => undefined);
    } catch {
      /* Logging must never affect a sync. */
    }
  }
}
