import { App, Modal, Setting } from 'obsidian';

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Confirm button label. */
  cta?: string;
  /** Cancel button label. */
  cancel?: string;
  /** Style the confirm button as destructive (red). */
  destructive?: boolean;
}

/**
 * Promise-based confirmation dialog — a plugin-friendly replacement for window.confirm
 * (which Obsidian's guidelines disallow). Resolves true on confirm, false on cancel/dismiss.
 */
export function confirmModal(app: App, opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, opts, resolve).open();
  });
}

class ConfirmModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly opts: ConfirmOptions,
    private readonly resolve: (value: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, opts } = this;
    contentEl.empty();
    new Setting(contentEl).setName(opts.title).setHeading();
    contentEl.createEl('p', { text: opts.message });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText(opts.cancel ?? 'Cancel')
        .onClick(() => this.decide(false)))
      .addButton(btn => {
        btn.setButtonText(opts.cta ?? 'Confirm');
        // `mod-warning` is the long-standing destructive-button class; setDestructive() needs 1.13.0.
        if (opts.destructive) btn.setClass('mod-warning');
        else btn.setCta();
        btn.onClick(() => this.decide(true));
      });
  }

  private decide(value: boolean): void {
    this.decided = true;
    this.resolve(value);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.resolve(false); // dismissed without choosing = cancel
  }
}
