import { SyncStatus } from '../types';

const STATUS_ICONS: Record<SyncStatus, string> = {
  idle: '🟢',
  syncing: '🔄',
  error: '🔴',
  conflict: '🟡',
};

export class StatusBarItem {
  private conflictCount = 0;
  private errorCount = 0;
  private status: SyncStatus = 'idle';
  private lastSyncTime: number | null = null;
  private progressText = '';

  constructor(private readonly el: HTMLElement) {
    this.render();
  }

  setStatus(status: SyncStatus): void {
    this.status = status;
    if (status !== 'syncing') this.progressText = '';
    this.render();
  }

  /** Show per-file progress during sync: "🔄 12/150" */
  setProgress(processed: number, total: number): void {
    this.status = 'syncing';
    this.progressText = `${processed}/${total}`;
    this.render();
  }

  setConflictCount(count: number): void {
    this.conflictCount = count;
    this.status = count > 0 ? 'conflict' : (this.errorCount > 0 ? 'error' : 'idle');
    this.render();
  }

  setErrorCount(count: number): void {
    this.errorCount = count;
    this.render();
  }

  setSyncComplete(uploadedCount: number, downloadedCount: number, conflictCount: number, errorCount: number): void {
    this.lastSyncTime = Date.now();
    this.conflictCount = conflictCount;
    this.errorCount = errorCount;
    this.progressText = '';
    this.status = conflictCount > 0 ? 'conflict' : (errorCount > 0 ? 'error' : 'idle');
    void uploadedCount; void downloadedCount;
    this.render();
  }

  private render(): void {
    const icon = STATUS_ICONS[this.status];
    let text = icon;

    if (this.status === 'syncing') {
      text = this.progressText ? `🔄 ${this.progressText}` : '🔄 Syncing…';
    } else if (this.conflictCount > 0) {
      text = `🟡 Conflicts: ${this.conflictCount}`;
    } else if (this.errorCount > 0) {
      text = `🔴 Errors: ${this.errorCount}`;
    } else if (this.lastSyncTime) {
      const t = new Date(this.lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      text = `🟢 ${t}`;
    } else {
      text = '🟢 Nextcloud';
    }

    this.el.setText(text);
    this.el.title = this.getTooltip();
  }

  private getTooltip(): string {
    if (this.conflictCount > 0) return `${this.conflictCount} unresolved conflict(s). Search #conflict to find them.`;
    if (this.errorCount > 0) return `${this.errorCount} file(s) failed to sync and will be retried.`;
    if (this.lastSyncTime) return `Last synced: ${new Date(this.lastSyncTime).toLocaleString()}`;
    return 'Nextcloud Sync';
  }
}
