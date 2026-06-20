import { App, Modal, Notice, Setting } from 'obsidian';
import { RemoteCompareResult } from '../types';
import { renderDiffSections } from './diffRender';
import { confirmModal } from './ConfirmModal';

/** The slice of SyncEngine that the compare popup needs (kept narrow for testability). */
export interface CompareEngine {
  compareWithRemote(path: string): Promise<RemoteCompareResult>;
  pushLocalToRemote(path: string): Promise<void>;
  pullRemoteToLocal(path: string): Promise<void>;
}

function fmtTime(ms: number | null): string {
  return ms != null ? new Date(ms).toLocaleString() : '—';
}

function shortHash(h: string | null): string {
  return h ? `${h.slice(0, 12)}…` : '—';
}

/**
 * Explorer "Compare with remote" popup (desktop, opt-in). Shows local vs remote modification time,
 * checksum (with a match/mismatch badge), and a line-level diff for text files. Offers two confirmed,
 * directional resolution actions: push (overwrite remote with local) and pull (overwrite local with
 * remote). Read-only until the user explicitly confirms a push/pull.
 */
export class CompareModal extends Modal {
  private result: RemoteCompareResult | null = null;
  private busy = false;

  constructor(
    app: App,
    private readonly path: string,
    private readonly engine: CompareEngine,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('ncs-diff-modal');
    this.renderLoading();
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    try {
      this.result = await this.engine.compareWithRemote(this.path);
    } catch (err) {
      // compareWithRemote captures expected failures in `state`; this guards the unexpected.
      this.result = {
        path: this.path, state: 'error', errorMessage: (err as Error)?.message ?? String(err),
        localExists: false, remoteExists: false, localMtime: null, remoteMtime: null,
        localChecksum: null, remoteChecksum: null, checksumMatch: false,
        localText: null, remoteText: null, diffAvailable: false, localSize: null, remoteSize: null,
      };
    }
    this.render();
  }

  private renderLoading(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Compare with remote' });
    contentEl.createEl('p', { text: this.path, cls: 'setting-item-description' });
    contentEl.createEl('p', { text: 'Fetching the remote version…', cls: 'setting-item-description' });
  }

  private render(): void {
    const { contentEl } = this;
    const r = this.result;
    if (!r) return;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Compare with remote' });
    contentEl.createEl('p', { text: r.path, cls: 'setting-item-description' });

    if (r.state === 'error') {
      contentEl.createEl('p', { text: `Could not compare: ${r.errorMessage ?? 'unknown error'}`, cls: 'mod-warning' });
      this.addCloseButton();
      return;
    }

    if (r.state === 'remote-missing') {
      contentEl.createEl('p', {
        text: 'This file has no remote counterpart (local-only). You can push it to create the remote copy.',
        cls: 'setting-item-description',
      });
    }

    this.addMetaRows(r);
    this.addDiff(r);
    this.addActions(r);
  }

  /** Modification time + checksum comparison rows, with a match/mismatch badge. */
  private addMetaRows(r: RemoteCompareResult): void {
    const { contentEl } = this;
    const table = contentEl.createDiv({ cls: 'ncs-compare-meta' });
    const row = (label: string, local: string, remote: string) => {
      const line = table.createDiv({ cls: 'ncs-compare-row' });
      line.createSpan({ cls: 'ncs-compare-label', text: label });
      line.createSpan({ cls: 'ncs-compare-local', text: local });
      line.createSpan({ cls: 'ncs-compare-remote', text: remote });
    };
    row('', 'Local', 'Remote');
    row('Modified', fmtTime(r.localMtime), fmtTime(r.remoteMtime));
    row('Checksum', shortHash(r.localChecksum), shortHash(r.remoteChecksum));
    row('Size', r.localSize != null ? `${r.localSize} B` : '—', r.remoteSize != null ? `${r.remoteSize} B` : '—');

    const badge = contentEl.createEl('p');
    if (r.remoteExists) {
      badge.setText(r.checksumMatch ? '✓ Checksums match — files are identical.' : '✗ Checksums differ.');
      badge.addClass(r.checksumMatch ? 'ncs-compare-match' : 'ncs-compare-mismatch');
    }
  }

  /** Line-level diff for text files; a notice for binary/non-text. */
  private addDiff(r: RemoteCompareResult): void {
    const { contentEl } = this;
    if (!r.diffAvailable || r.localText == null || r.remoteText == null) {
      if (r.remoteExists) {
        contentEl.createEl('p', { text: 'Line diff unavailable for this file type.', cls: 'setting-item-description' });
      }
      return;
    }
    const headers = contentEl.createDiv({ cls: 'ncs-diff-headers' });
    for (const txt of ['Local', 'Remote']) {
      headers.createDiv({ cls: 'ncs-diff-gutter' });
      headers.createDiv({ cls: 'ncs-diff-marker' });
      headers.createDiv({ text: txt, cls: 'ncs-diff-header-cell' });
    }
    const scrollEl = contentEl.createDiv({ cls: 'ncs-diff-scroll' });
    const firstChanged = renderDiffSections(scrollEl, r.localText, r.remoteText);
    if (firstChanged) {
      window.requestAnimationFrame(() => firstChanged.scrollIntoView({ block: 'center' }));
    }
  }

  /** Push / pull resolution buttons (each behind a confirmation), shown only when applicable. */
  private addActions(r: RemoteCompareResult): void {
    const setting = new Setting(this.contentEl);
    // Push (local → remote): meaningful whenever a local file exists (creates or overwrites remote).
    if (r.localExists) {
      setting.addButton(btn => btn
        .setButtonText('Push (overwrite remote)')
        .setClass('mod-warning')
        .onClick(() => void this.resolve('push')));
    }
    // Pull (remote → local): only when a remote counterpart exists.
    if (r.remoteExists) {
      setting.addButton(btn => btn
        .setButtonText('Pull (overwrite local)')
        .setClass('mod-warning')
        .onClick(() => void this.resolve('pull')));
    }
    setting.addButton(btn => btn.setButtonText('Close').onClick(() => this.close()));
  }

  private addCloseButton(): void {
    new Setting(this.contentEl).addButton(btn => btn.setButtonText('Close').setCta().onClick(() => this.close()));
  }

  private async resolve(direction: 'push' | 'pull'): Promise<void> {
    if (this.busy) return;
    const isPush = direction === 'push';
    const ok = await confirmModal(this.app, {
      title: isPush ? 'Overwrite remote?' : 'Overwrite local?',
      message: isPush
        ? `This overwrites the remote copy of "${this.path}" with your local version. This cannot be undone.`
        : `This overwrites your local copy of "${this.path}" with the remote version. This cannot be undone.`,
      cta: isPush ? 'Push' : 'Pull',
      destructive: true,
    });
    if (!ok) return;

    this.busy = true;
    try {
      if (isPush) await this.engine.pushLocalToRemote(this.path);
      else await this.engine.pullRemoteToLocal(this.path);
    } catch (err) {
      this.busy = false;
      new Notice(`${isPush ? 'Push' : 'Pull'} failed: ${(err as Error)?.message ?? err}`);
      return; // leave the popup as-is; do NOT claim success
    }
    this.busy = false;
    new Notice(isPush ? 'Pushed local to remote.' : 'Pulled remote to local.');
    // Re-run the comparison so the popup reflects the now-matching state.
    this.renderLoading();
    await this.load();
  }
}
