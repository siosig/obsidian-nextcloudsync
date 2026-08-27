// Session-scoped recording, lifted out of SyncEngine (feature 074, Phase 3).
//
// Everything the engine writes ABOUT a sync rather than as part of one: the session summary, the
// per-file history, the error list the status dialog reads. It owns the run's start time, because
// that is the grouping key those records share and nothing else needs it.
//
// This is the module the transfer extraction was waiting on. Transfer used to reach back into the
// engine for recordHistory/recordError — a call into the middle of the graph. With the journal as a
// collaborator it can be injected instead, which is what makes transfer a leaf at all.
//
// Unlike `sync/policy` and `sync/scan` this module DOES hold state (the run start time). That is not
// a relaxation of the rule those modules follow: they are leaf predicates with nothing to own, while
// a journal without a current run is not a journal. The state it holds is its own, not the engine's
// borrowed.
import { SyncSessionSummary, SyncFileOp, SyncHistoryDetail } from '../../types';
import { SyncHistoryStore } from '../../data/SyncHistoryStore';
import { FileLogger } from '../../util/FileLogger';

export interface SyncJournalDeps {
  historyStore?: Pick<SyncHistoryStore, 'record'>;
  logger?: Pick<FileLogger, 'log'>;
}

export class SyncJournal {
  /**
   * Start time of the sync run currently in progress, or null outside one. Watch-mode single-file ops
   * run with no session, and each is then its own group (see {@link recordHistory}).
   */
  private runStartedAt: number | null = null;

  constructor(private readonly deps: SyncJournalDeps) {}

  /** Tag every history entry recorded from here on with this run's start time. */
  beginRun(startedAt: number): void {
    this.runStartedAt = startedAt;
  }

  /** Leave the run; subsequent entries group by their own time again. */
  endRun(): void {
    this.runStartedAt = null;
  }

  /** A fresh, zeroed session summary. */
  newSummary(): SyncSessionSummary {
    return {
      startedAt: Date.now(), completedAt: null,
      uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
      mergedCount: 0, conflictedCount: 0,
      errorCount: 0, retriedFiles: [], errors: [],
    };
  }

  /** Count an error and keep its detail for the sync-status dialog. Empty path = session-level. */
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

  /** Append one per-file outcome to the persisted 24h history (no-op when no store is injected). */
  recordHistory(path: string, op: SyncFileOp, message?: string, detail?: SyncHistoryDetail): void {
    const now = Date.now();
    // Group key for the Sync Status dialog: the active full-sync run's start time, or — for watch-mode
    // single-file ops (no session) — this op's own time, so each forms its own group.
    const runStartedAt = this.runStartedAt ?? now;
    this.deps.historyStore?.record(path, op, now, message, detail, runStartedAt);
  }

  /**
   * Write every collected failure to the debug log, one line per error, with its path.
   *
   * No cap on purpose (URE-5): issue #25 reported `err=162` with not one of the 162 paths
   * identifiable, which is exactly what a truncated summary costs when the log is the only evidence.
   */
  logSessionErrors(summary: SyncSessionSummary): void {
    for (const e of summary.errors) {
      void this.deps.logger?.log(`sync: error ${e.path} — ${e.message}`);
    }
  }
}
