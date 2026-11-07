// Records what the engine writes ABOUT a sync (session summary, per-file history, error list) and owns the
// run start time those records are grouped by. Unlike the leaf modules it holds state: a journal without
// a current run is not a journal.
import { SyncSessionSummary, SyncFileOp, SyncHistoryDetail, OversizeSkip } from '../../types';
import { SyncHistoryStore } from '../../data/SyncHistoryStore';
import { FileLogger } from '../../util/FileLogger';

export interface SyncJournalDeps {
  historyStore?: Pick<SyncHistoryStore, 'record'>;
  logger?: Pick<FileLogger, 'log'>;
}

export class SyncJournal {
  // Start time of the run in progress, or null outside one (watch-mode single-file ops have no session).
  private runStartedAt: number | null = null;

  constructor(private readonly deps: SyncJournalDeps) {}

  beginRun(startedAt: number): void {
    this.runStartedAt = startedAt;
  }

  endRun(): void {
    this.runStartedAt = null;
  }

  newSummary(): SyncSessionSummary {
    return {
      startedAt: Date.now(), completedAt: null,
      uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
      mergedCount: 0, conflictedCount: 0,
      errorCount: 0, retriedFiles: [], pluginsNeedingRestart: [], errors: [],
      oversizeSkippedPaths: new Set(),
    };
  }

  /**
   * Records an over-the-limit skip in `summary`. The first record of a path in a summary adds it to
   * `summary.oversizeSkippedPaths` and logs one line; later records of the same path do nothing.
   * Never notifies (docs/spec.md §9.4a).
   */
  recordOversizeSkip(summary: SyncSessionSummary, skip: OversizeSkip): void {
    if (summary.oversizeSkippedPaths.has(skip.path)) return;
    summary.oversizeSkippedPaths.add(skip.path);
    const msg = `size-limit: skipped ${skip.direction} (${skip.sizeBytes}B > ${skip.limitMB}MB) → ${skip.path}`;
    try {
      void Promise.resolve(this.deps.logger?.log(msg)).catch(() => undefined);
    } catch {
      /* Logging must never affect a sync. */
    }
  }

  // An empty path means a session-level error.
  recordError(
    summary: SyncSessionSummary,
    path: string,
    err: unknown,
    skippedPaths?: { all: string[] },
    dirBreakerSkipped?: { deleteRemote: string[]; trashLocal: string[] },
  ): void {
    summary.errorCount++;
    const message = err instanceof Error ? err.message : String(err);
    summary.errors.push({ path, message, skippedPaths, dirBreakerSkipped });
    if (path) this.recordHistory(path, 'error', message); // session-level errors aren't file history
  }

  recordHistory(path: string, op: SyncFileOp, message?: string, detail?: SyncHistoryDetail): void {
    const now = Date.now();
    // Group key: the active run's start time, or this op's own time for watch-mode ops so each is its own group.
    const runStartedAt = this.runStartedAt ?? now;
    this.deps.historyStore?.record(path, op, now, message, detail, runStartedAt);
  }

  // No cap on purpose: issue #25 reported `err=162` with none of the paths identifiable, which is what a
  // truncated summary costs when the log is the only evidence.
  logSessionErrors(summary: SyncSessionSummary): void {
    for (const e of summary.errors) {
      void this.deps.logger?.log(`sync: error ${e.path} — ${e.message}`);
    }
  }
}
