// Pure status-filter logic for the Sync Status dialog, separated from the view (SyncStatusModal)
// so it can be unit-tested without a DOM and reused independently (SRP).

import { SyncErrorDetail, SyncFileOp, SyncHistoryEntry, SyncSessionSummary } from '../types';

/** The data the Sync Status dialog renders (and the filter acts on). */
export interface SyncStatusReport {
  summary: SyncSessionSummary | null;
  conflictedFiles: string[];
  retryFiles: string[];
  /** Per-file sync outcomes within the last 24h, newest first. */
  history: SyncHistoryEntry[];
}

/** Every status the dialog can show — one filter checkbox is rendered per entry (in this order). */
export const ALL_FILTER_OPS: SyncFileOp[] = [
  'uploaded', 'downloaded', 'deleted', 'merged', 'conflicted', 'local-wins', 'remote-wins', 'error',
];

/** Session-lifetime filter selection: the set of statuses currently shown. Default = all checked. */
export interface StatusFilterState {
  checked: Set<SyncFileOp>;
}

/** A fresh filter state with every status checked (the default each time Obsidian starts). */
export function makeDefaultFilterState(): StatusFilterState {
  return { checked: new Set<SyncFileOp>(ALL_FILTER_OPS) };
}

/** Whether entries of `op` should be shown under the current selection. */
export function isVisible(op: SyncFileOp, checked: Set<SyncFileOp>): boolean {
  return checked.has(op);
}

/** A report whose every section has been filtered down to the currently-checked statuses. */
interface FilteredStatusReport {
  history: SyncHistoryEntry[];
  conflictedFiles: string[];
  retryFiles: string[];
  errors: SyncErrorDetail[];
}

/**
 * Apply the status filter to every section of the report. History rows filter by their own `op`;
 * the conflicts section is governed by `conflicted`; the retry queue and the per-session error
 * list are governed by `error` (retry/error entries are failed operations).
 */
export function filterReport(report: SyncStatusReport, checked: Set<SyncFileOp>): FilteredStatusReport {
  const errors = report.summary?.errors ?? [];
  return {
    history: report.history.filter(e => isVisible(e.op, checked)),
    conflictedFiles: isVisible('conflicted', checked) ? report.conflictedFiles : [],
    retryFiles: isVisible('error', checked) ? report.retryFiles : [],
    errors: isVisible('error', checked) ? errors : [],
  };
}
