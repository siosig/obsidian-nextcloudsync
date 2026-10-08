// Pure filter logic for the Sync Status dialog, kept apart from the view so it is testable without a DOM.

import { SyncErrorDetail, SyncFileOp, SyncHistoryEntry, SyncSessionSummary } from '../types';

export interface SyncStatusReport {
  summary: SyncSessionSummary | null;
  conflictedFiles: string[];
  retryFiles: string[];
  history: SyncHistoryEntry[];
}

export const ALL_FILTER_OPS: SyncFileOp[] = [
  'uploaded', 'downloaded', 'deleted', 'merged', 'conflicted', 'local-wins', 'remote-wins', 'error',
];

export interface StatusFilterState {
  checked: Set<SyncFileOp>;
}

export function makeDefaultFilterState(): StatusFilterState {
  return { checked: new Set<SyncFileOp>(ALL_FILTER_OPS) };
}

// The empty array means "all unchecked", which differs from undefined ("not yet saved").
export function serializeFilter(state: StatusFilterState): SyncFileOp[] {
  return [...state.checked];
}

// Tolerant of missing/garbage data: non-arrays give the all-on default and unknown keys are dropped.
// An explicit empty array stays "all unchecked".
export function deserializeFilter(saved: unknown): StatusFilterState {
  if (!Array.isArray(saved)) return makeDefaultFilterState();
  const valid = new Set<SyncFileOp>(ALL_FILTER_OPS);
  return { checked: new Set<SyncFileOp>(saved.filter((s): s is SyncFileOp => valid.has(s as SyncFileOp))) };
}

export interface SyncRunGroup {
  runStartedAt: number;
  entries: SyncHistoryEntry[];
}

// Groups by runStartedAt, falling back to the entry's own `at` (each legacy entry forms its own group).
// Filter BEFORE grouping so a run whose entries are all hidden never yields an empty separator.
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

export function isVisible(op: SyncFileOp, checked: Set<SyncFileOp>): boolean {
  return checked.has(op);
}

interface FilteredStatusReport {
  history: SyncHistoryEntry[];
  conflictedFiles: string[];
  retryFiles: string[];
  errors: SyncErrorDetail[];
}

// History rows filter by their own op; conflicts follow `conflicted`; the retry queue and session errors follow `error`.
export function filterReport(report: SyncStatusReport, checked: Set<SyncFileOp>): FilteredStatusReport {
  const errors = report.summary?.errors ?? [];
  return {
    history: report.history.filter(e => isVisible(e.op, checked)),
    conflictedFiles: isVisible('conflicted', checked) ? report.conflictedFiles : [],
    retryFiles: isVisible('error', checked) ? report.retryFiles : [],
    errors: isVisible('error', checked) ? errors : [],
  };
}
