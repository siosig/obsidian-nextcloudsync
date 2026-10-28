import { Notice } from 'obsidian';
import { SyncStatus } from '../types';
import { IStatusBar } from './StatusBarItem';

/** Auto-dismiss delays (ms) for the completion toast. */
const DISMISS_SUCCESS_MS = 4000;
const DISMISS_PROBLEM_MS = 10000;

// Mobile has no status bar (addStatusBarItem is unavailable), so feedback is one reused Notice:
// persistent while syncing, then updated in place to an auto-dismissing summary.
// Invariant: at most one Notice is live; a new sync reclaims a still-visible completion toast.
export class NoticeStatusBar implements IStatusBar {
  private notice: Notice | null = null;
  private conflictCount = 0;
  private errorCount = 0;
  private dismissTimer: number | null = null;
  // True while an automatic sync has not yet shown a toast; it stays silent unless there is news.
  private quiet = false;

  setStatus(status: SyncStatus, opts?: { automatic?: boolean }): void {
    if (status !== 'syncing') return; // idle/error/conflict alone never pops a toast; completion drives the result
    this.quiet = opts?.automatic === true;
    if (this.quiet) return;
    this.clearDismiss();
    this.ensureNotice('🔄 Syncing…');
  }

  setProgress(processed: number, total: number, label?: string): void {
    this.show(label ? `🔄 ${label} ${processed}/${total}` : `🔄 ${processed}/${total}`);
  }

  // Only the first sync reports phases, and it is long enough to be worth a toast even when automatic.
  setPhase(label: string): void {
    this.show(`🔄 ${label}…`);
  }

  private show(text: string): void {
    this.quiet = false;
    this.clearDismiss();
    this.ensureNotice('🔄 Syncing…');
    this.notice?.setMessage(text);
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
    const hasNews = uploadedCount + downloadedCount > 0 || conflictCount > 0 || errorCount > 0;
    if (this.quiet && !hasNews) {
      this.quiet = false;
      return;
    }
    this.quiet = false;
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

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
