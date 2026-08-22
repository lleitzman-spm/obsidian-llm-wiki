// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { installConfirmModalBehavior } from '../../ui/confirm-modal-behavior';

function makeDom() {
  const contentEl = document.createElement('div');
  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Skip';
  const confirmButton = document.createElement('button');
  confirmButton.className = 'mod-cta';
  confirmButton.textContent = 'Re-ingest';
  contentEl.append(cancelButton, confirmButton);
  document.body.append(contentEl);
  return { contentEl, cancelButton, confirmButton };
}

describe('ConfirmModal governed re-ingest DOM behavior', () => {
  it('explicitly focuses Re-ingest when the modal opens', () => {
    const { contentEl, confirmButton } = makeDom();
    const dispose = installConfirmModalBehavior({ contentEl, cancelButton: contentEl.querySelector('button')!, confirmButton, decide: vi.fn() });

    expect(document.activeElement).toBe(confirmButton);
    dispose();
  });

  it('confirms once for Enter/Space on the focused CTA', () => {
    const { contentEl, confirmButton } = makeDom();
    const decide = vi.fn();
    const dispose = installConfirmModalBehavior({ contentEl, cancelButton: contentEl.querySelector('button')!, confirmButton, decide });

    confirmButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    confirmButton.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));

    expect(decide).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledWith(true);
    dispose();
  });

  it('cancels on Escape and Skip, while the caller owns one-shot resolution', () => {
    const escapeDom = makeDom();
    const escapeDecide = vi.fn();
    const disposeEscape = installConfirmModalBehavior({
      contentEl: escapeDom.contentEl,
      cancelButton: escapeDom.cancelButton,
      confirmButton: escapeDom.confirmButton,
      decide: escapeDecide,
    });
    escapeDom.contentEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(escapeDecide).toHaveBeenCalledOnce();
    expect(escapeDecide).toHaveBeenCalledWith(false);
    disposeEscape();

    const skipDom = makeDom();
    const skipDecide = vi.fn();
    const disposeSkip = installConfirmModalBehavior({ contentEl: skipDom.contentEl, cancelButton: skipDom.cancelButton, confirmButton: skipDom.confirmButton, decide: skipDecide });
    skipDom.cancelButton.click();
    expect(skipDecide).toHaveBeenCalledOnce();
    expect(skipDecide).toHaveBeenCalledWith(false);
    const callsBeforeDispose = skipDecide.mock.calls.length;
    disposeSkip();
    skipDom.confirmButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(skipDecide).toHaveBeenCalledTimes(callsBeforeDispose);
  });

  it('removes keyboard handlers on close and tolerates inaccessible focus', () => {
    const { contentEl, confirmButton } = makeDom();
    const decide = vi.fn();
    const originalFocus = confirmButton.focus;
    confirmButton.focus = () => { throw new Error('focus unavailable'); };
    const dispose = installConfirmModalBehavior({ contentEl, cancelButton: contentEl.querySelector('button')!, confirmButton, decide });

    expect(contentEl.getAttribute('tabindex')).toBe('-1');
    dispose();
    dispose();
    confirmButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    contentEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(decide).not.toHaveBeenCalled();
    confirmButton.focus = originalFocus;
  });
});
