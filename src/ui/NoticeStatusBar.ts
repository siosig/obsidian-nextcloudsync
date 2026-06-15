import { Notice } from 'obsidian';
import { SyncStatus } from '../types';
import { IStatusBar } from './StatusBarItem';

/** Auto-dismiss delays (ms) for the completion toast. */
const DISMISS_SUCCESS_MS = 4000;
const DISMISS_PROBLEM_MS = 10000;

/**
 * Mobile implementation of {@link IStatusBar}. Obsidian has no visible status bar on mobile
 * (`addStatusBarItem` is unavailable there), so sync feedback is surfaced as a single, reused
 * `Notice` toast: persistent (`timeout = 0`) while syncing, then updated in place to a result
 * summary that auto-dismisses. This keeps the sync engine free of platform branching — it just
 * drives the IStatusBar port, and the mobile wiring swaps this in for NullStatusBar.
 *
 * Single-toast invariant: at most one Notice is ever live; progress updates reuse it via
 * `setMessage`, and a new sync reclaims a still-visible completion toast instead of stacking.
 */
export class NoticeStatusBar implements IStatusBar {
  private notice: Notice | null = null;
  private conflictCount = 0;
  private errorCount = 0;
  private dismissTimer: number | null = null;

  setStatus(status: SyncStatus): void {
    if (status !== 'syncing') return; // idle/error/conflict alone never pops a toast; completion drives the result
    this.clearDismiss();
    this.ensureNotice('🔄 Syncing…');
  }

  /** Show per-file progress, reusing the single toast: "🔄 12/150". */
  setProgress(processed: number, total: number): void {
    this.clearDismiss();
    this.ensureNotice('🔄 Syncing…');
    this.notice?.setMessage(`🔄 ${processed}/${total}`);
  }

  setConflictCount(count: number): void {
    this.conflictCount = count;
  }

  setErrorCount(count: number): void {
    this.errorCount = count;
  }

  setSyncComplete(uploadedCount: number, downloadedCount: number, conflictCount: number, errorCount: number): void {
    this.conflictCount = conflictCount;
    this.errorCount = errorCount;
    this.clearDismiss();
    this.ensureNotice('🔄 Syncing…'); // defensive: surface a result even if setStatus('syncing') was skipped

    const { text, dismissMs } = this.renderComplete(uploadedCount, downloadedCount, conflictCount, errorCount);
    this.notice?.setMessage(text);

    const notice = this.notice;
    this.dismissTimer = window.setTimeout(() => {
      notice?.hide();
      if (this.notice === notice) this.notice = null;
      this.dismissTimer = null;
    }, dismissMs);
  }

  private renderComplete(up: number, down: number, conflict: number, error: number): { text: string; dismissMs: number } {
    const tail = `↑${up} ↓${down}`;
    if (error > 0) return { text: `🔴 ${count(error, 'error')} — ${tail}`, dismissMs: DISMISS_PROBLEM_MS };
    if (conflict > 0) return { text: `🟡 ${count(conflict, 'conflict')} — ${tail}`, dismissMs: DISMISS_PROBLEM_MS };
    if (up + down === 0) return { text: '🟢 Up to date', dismissMs: DISMISS_SUCCESS_MS };
    return { text: `🟢 Synced ${tail}`, dismissMs: DISMISS_SUCCESS_MS };
  }

  /** Create the persistent toast if absent, otherwise reuse it (single-toast invariant). */
  private ensureNotice(initialText: string): void {
    if (!this.notice) this.notice = new Notice(initialText, 0);
  }

  private clearDismiss(): void {
    if (this.dismissTimer !== null) {
      window.clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }
}

/** "1 error" / "2 errors" — simple English pluralization. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
