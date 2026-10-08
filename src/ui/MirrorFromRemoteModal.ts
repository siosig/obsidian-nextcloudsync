import { App, Modal, Setting } from 'obsidian';
import { MirrorPlan, MirrorResult } from '../sync/mirrorPlan';

export interface MirrorModalHandlers {
  // Planning lists the whole remote (network-heavy), so it reports coarse phase labels via onPhase to keep the dialog visibly alive.
  plan: (onPhase: (label: string) => void) => Promise<MirrorPlan>;
  apply: (plan: MirrorPlan, onProgress: (done: number, total: number) => void) => Promise<MirrorResult>;
}

// The dialog opens immediately on click and drives planning, confirmation, applying and the result in one modal,
// so the plugin never looks frozen during network-heavy planning. Resolves at a terminal state; if dismissed
// mid-apply it resolves once the apply finishes, so the caller's in-progress guard stays held.
export function openMirrorFromRemoteModal(app: App, handlers: MirrorModalHandlers): Promise<void> {
  return new Promise((resolve) => {
    new MirrorFromRemoteModal(app, handlers, resolve).open();
  });
}

class MirrorFromRemoteModal extends Modal {
  private cancelled = false;
  private applying = false;
  private closed = false;
  private done = false;
  private plan: MirrorPlan | null = null;

  constructor(
    app: App,
    private readonly h: MirrorModalHandlers,
    private readonly resolveDone: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.renderPlanning('Preparing…');
    void this.runPlanning();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    // If dismissed while an apply is still running, defer completion until the apply finishes (so the
    // caller's guard stays held). Otherwise the operation is over — resolve now.
    if (!this.applying) this.finish();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.resolveDone();
  }

  private heading(): void {
    new Setting(this.contentEl).setName('Mirror from remote').setHeading();
  }

  private renderPlanning(label: string): void {
    const { contentEl } = this;
    contentEl.empty();
    this.heading();
    contentEl.createEl('p', {
      text: 'This device will be made to exactly match the remote.',
      cls: 'setting-item-description',
    });
    contentEl.createEl('p', { text: label, attr: { 'data-role': 'status' } });
    contentEl.createEl('progress'); // no value attribute ⇒ indeterminate (animated) bar
    new Setting(contentEl).addButton((btn) => btn
      .setButtonText('Cancel')
      .onClick(() => { this.cancelled = true; this.close(); }));
  }

  private setPhaseLabel(label: string): void {
    if (this.closed) return;
    const status = this.contentEl.querySelector('p[data-role="status"]');
    if (status) status.textContent = label;
  }

  private async runPlanning(): Promise<void> {
    try {
      const plan = await this.h.plan((label) => this.setPhaseLabel(label));
      if (this.cancelled || this.closed) return;
      if (!plan.ok) {
        this.renderMessage('❌ Mirror aborted', `${plan.reason ?? 'Could not read the remote'} — no files were changed.`);
        return;
      }
      this.plan = plan;
      this.renderConfirm(plan);
    } catch (err) {
      if (!this.cancelled && !this.closed) this.renderMessage('❌ Mirror failed', (err as Error).message);
    }
  }

  private renderConfirm(plan: MirrorPlan): void {
    const deleteCount = plan.deleteFiles.length + plan.deleteDirs.length;
    if (plan.downloads.length === 0 && deleteCount === 0) {
      this.renderMessage('Already in sync', 'This device already matches the remote — nothing to mirror.');
      return;
    }
    const { contentEl } = this;
    contentEl.empty();
    this.heading();
    const info = contentEl.createDiv({ cls: 'setting-item-description' });
    info.createEl('p', { text: 'This will make this device exactly match the remote:' });
    const ul = info.createEl('ul');
    ul.createEl('li', { text: `Download: ${plan.downloads.length} file(s)` });
    ul.createEl('li', { text: `Delete locally: ${deleteCount} file(s)/folder(s) not on the remote (moved to your Obsidian trash — recoverable)` });
    if (plan.skipCount > 0) ul.createEl('li', { text: `Already in sync: ${plan.skipCount} file(s)` });
    info.createEl('p', { text: 'Unsynced local changes will be discarded. This cannot be undone except from the trash.' });

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText('Cancel').onClick(() => { this.cancelled = true; this.close(); }))
      .addButton((btn) => btn.setButtonText('Mirror from remote').setClass('mod-warning').onClick(() => void this.runApply()));
  }

  private async runApply(): Promise<void> {
    const plan = this.plan;
    if (!plan) return;
    const total = plan.downloads.length + plan.deleteFiles.length + plan.deleteDirs.length;

    const { contentEl } = this;
    contentEl.empty();
    this.heading();
    const label = contentEl.createEl('p', { text: `Mirroring… 0 / ${total}` });
    const bar = contentEl.createEl('progress');
    bar.max = Math.max(1, total);
    bar.value = 0;

    this.applying = true;
    try {
      const result = await this.h.apply(plan, (doneN, tot) => {
        if (this.closed) return;
        bar.max = Math.max(1, tot);
        bar.value = doneN;
        label.textContent = `Mirroring… ${doneN} / ${tot}`;
      });
      this.applying = false;
      if (this.closed) { this.finish(); return; } // dismissed mid-apply → just release the guard
      this.renderResult(result);
    } catch (err) {
      this.applying = false;
      if (this.closed) { this.finish(); return; }
      this.renderMessage('❌ Mirror failed', (err as Error).message);
    }
  }

  private renderResult(result: MirrorResult): void {
    const { contentEl } = this;
    contentEl.empty();
    this.heading();
    const ok = result.errors.length === 0;
    contentEl.createEl('p', { text: ok ? '✅ Mirror complete.' : `⚠️ Mirror finished with ${result.errors.length} error(s).` });
    const ul = contentEl.createEl('ul', { cls: 'setting-item-description' });
    ul.createEl('li', { text: `Downloaded: ${result.downloaded}` });
    ul.createEl('li', { text: `Deleted locally: ${result.deleted}` });
    ul.createEl('li', { text: `Already in sync: ${result.skipped}` });
    if (result.errors.length > 0) {
      const errList = contentEl.createEl('ul');
      for (const e of result.errors.slice(0, 10)) errList.createEl('li', { text: `${e.path}: ${e.message}` });
      if (result.errors.length > 10) errList.createEl('li', { text: `…and ${result.errors.length - 10} more` });
    }
    new Setting(contentEl).addButton((btn) => btn.setButtonText('Close').setCta().onClick(() => this.close()));
  }

  private renderMessage(title: string, body: string): void {
    const { contentEl } = this;
    contentEl.empty();
    this.heading();
    contentEl.createEl('p', { text: title });
    contentEl.createEl('p', { text: body, cls: 'setting-item-description' });
    new Setting(contentEl).addButton((btn) => btn.setButtonText('Close').setCta().onClick(() => this.close()));
  }
}
