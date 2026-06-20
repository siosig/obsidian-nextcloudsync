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

/** A fresh filter state with every status checked (the default when nothing is persisted). */
export function makeDefaultFilterState(): StatusFilterState {
  return { checked: new Set<SyncFileOp>(ALL_FILTER_OPS) };
}

/**
 * Serialize the filter selection to a JSON-friendly array (for persistence in settings).
 * The empty array is meaningful ("all unchecked"), distinct from "not yet saved" (undefined).
 */
export function serializeFilter(state: StatusFilterState): SyncFileOp[] {
  return [...state.checked];
}

/**
 * Rebuild a filter state from a persisted value (tolerant of missing/garbage data):
 *   - undefined / null / non-array  → all-on default (no saved selection)
 *   - array                         → keep only entries that are valid statuses (unknown keys dropped)
 * An explicit empty array yields an empty set ("all unchecked"), a valid user choice.
 */
export function deserializeFilter(saved: unknown): StatusFilterState {
  if (!Array.isArray(saved)) return makeDefaultFilterState();
  const valid = new Set<SyncFileOp>(ALL_FILTER_OPS);
  return { checked: new Set<SyncFileOp>(saved.filter((s): s is SyncFileOp => valid.has(s as SyncFileOp))) };
}

/** A set of recent-activity entries produced by one sync run, labelled by that run's start time. */
export interface SyncRunGroup {
  /** Group key / separator label source: the run's start time (or a legacy entry's own `at`). */
  runStartedAt: number;
  /** Entries of this run, newest first. */
  entries: SyncHistoryEntry[];
}

/**
 * Group recent-activity entries by the sync run that produced them (FR-005..008). Grouping key is
 * `entry.runStartedAt` when present, else the entry's own `at` (legacy fallback — each legacy entry
 * forms its own group). Groups are returned newest-run-first; entries within a group are newest-first.
 * Filtering is expected to happen BEFORE grouping, so a run whose entries are all hidden never yields
 * an (empty) separator. Pure: no clock read, deterministic for a given input.
 */
export function groupByRun(entries: SyncHistoryEntry[]): SyncRunGroup[] {
  const byKey = new Map<number, SyncHistoryEntry[]>();
  for (const e of entries) {
    const key = e.runStartedAt ?? e.at;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(e);
    else byKey.set(key, [e]);
  }
  return [...byKey.entries()]
    .map(([runStartedAt, es]) => ({ runStartedAt, entries: es.sort((a, b) => b.at - a.at) }))
    .sort((a, b) => b.runStartedAt - a.runStartedAt);
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
