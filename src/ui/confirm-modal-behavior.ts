/**
 * Keyboard and focus behavior for the source-specific re-ingest confirmation.
 *
 * Kept independent of Obsidian's Modal class so the behavior can be exercised
 * with a real DOM in unit tests as well as in Obsidian.
 */

export interface ConfirmModalBehaviorOptions {
  contentEl: HTMLElement;
  cancelButton: HTMLElement;
  confirmButton: HTMLElement;
  decide: (confirmed: boolean) => void;
}

function tryFocus(element: HTMLElement): boolean {
  try {
    if (typeof element.focus !== 'function') return false;
    element.focus();
    return true;
  } catch {
    return false;
  }
}

/** Install deterministic CTA focus and one-shot keyboard cancellation/confirm. */
export function installConfirmModalBehavior({ contentEl, cancelButton, confirmButton, decide }: ConfirmModalBehaviorOptions): () => void {
  let decided = false;
  const choose = (confirmed: boolean): void => {
    if (decided) return;
    decided = true;
    decide(confirmed);
  };
  const onCancelClick = (): void => choose(false);
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    choose(false);
  };
  const onConfirmKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    event.preventDefault();
    event.stopPropagation();
    choose(true);
  };

  cancelButton.addEventListener('click', onCancelClick);
  contentEl.addEventListener('keydown', onEscape);
  confirmButton.addEventListener('keydown', onConfirmKey);

  // The CTA is the explicit safe default. If a host/webview denies focus,
  // make the modal content a non-tabbing fallback and fail closed without
  // turning an accessibility problem into a modal-open failure.
  if (!tryFocus(confirmButton)) {
    if (!contentEl.hasAttribute('tabindex')) contentEl.setAttribute('tabindex', '-1');
    tryFocus(contentEl);
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    cancelButton.removeEventListener('click', onCancelClick);
    contentEl.removeEventListener('keydown', onEscape);
    confirmButton.removeEventListener('keydown', onConfirmKey);
  };
}
