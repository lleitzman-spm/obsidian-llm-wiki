// ConfirmModal — small yes/no confirmation modal (#164).
//
// `onChoice` fires exactly once:
//   - true on confirm
//   - false on cancel / Escape / dismiss / onClose.
//
// Extracted from the original `src/ui/modals.ts` god file (PR split).
// No behavior change — pure code movement.

import { App, Modal } from 'obsidian';
import { installConfirmModalBehavior } from '../confirm-modal-behavior';

export class ConfirmModal extends Modal {
  private decided = false;
  private disposeBehavior?: () => void;

  constructor(
    app: App,
    private opts: { title: string; body: string; confirmText: string; cancelText: string; onChoice: (confirmed: boolean) => void }
  ) {
    super(app);
  }

  onOpen() {
    this.contentEl.createEl('h2', { text: this.opts.title });
    this.contentEl.createEl('p', { text: this.opts.body });
    const btnRow = this.contentEl.createDiv({ attr: { style: 'margin-top: 16px; text-align: right;' } });
    const cancelButton = btnRow.createEl('button', { text: this.opts.cancelText, attr: { type: 'button' } });
    const confirmButton = btnRow.createEl('button', {
      text: this.opts.confirmText,
      cls: 'mod-cta',
      attr: { type: 'button', style: 'margin-left: 8px;' },
    });
    confirmButton
      .addEventListener('click', () => this.decide(true));
    this.disposeBehavior = installConfirmModalBehavior({
      contentEl: this.contentEl,
      cancelButton,
      confirmButton,
      decide: (confirmed) => this.decide(confirmed),
    });
  }

  private decide(confirmed: boolean) {
    if (this.decided) return;
    this.decided = true;
    this.opts.onChoice(confirmed);
    this.close();
  }

  onClose() {
    this.disposeBehavior?.();
    this.disposeBehavior = undefined;
    this.contentEl.empty();
    // Escape / X / click-outside → treat as cancel, exactly once.
    if (!this.decided) {
      this.decided = true;
      this.opts.onChoice(false);
    }
  }
}
