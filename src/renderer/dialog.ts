import { h } from './dom';

// Questions and notices drawn by the app in its own style instead of the browser's confirm() and
// alert(). The first paragraph of the text is the heading, the rest is drawn below it. Enter or Space
// answers yes, Esc cancels, and while a dialog is open it takes every key so nothing reaches the
// terminal behind it. Dialogs asked for while one is open wait their turn. The focus goes back to
// where it was once the dialog closes.

export interface AskOptions {
  /** Label of the button that answers yes. */
  ok?: string;
  /** Label of the button that cancels. */
  cancel?: string;
  /** Loses data, so the yes button is drawn in red. */
  danger?: boolean;
}

let queue: Promise<unknown> = Promise.resolve();

/** Asks a yes/no question; resolves true for yes (its button, Enter or Space), false for cancel or Esc. */
export function ask(message: string, { ok = 'OK', cancel = 'Cancel', danger = false }: AskOptions = {}): Promise<boolean> {
  return enqueue(() => open(message, ok, cancel, danger));
}

/** Shows a notice with one button; any of Enter, Space or Esc closes it. */
export function tell(message: string): Promise<void> {
  return enqueue(() => open(message, 'OK', null, false)).then(() => undefined);
}

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

function open(message: string, okLabel: string, cancelLabel: string | null, danger: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const done = new AbortController();
    const previous = document.activeElement as HTMLElement | null;
    const [title, ...rest] = message.split(/\n\n/);
    const body = rest.join('\n\n');

    const backdrop = h('div', 'dialog-backdrop');
    const box = h('div', 'dialog');
    box.setAttribute('role', cancelLabel === null ? 'alertdialog' : 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.tabIndex = -1;
    box.append(h('div', 'dialog-title', title));
    if (body) box.append(h('div', 'dialog-body', body));
    const buttons = h('div', 'dialog-buttons');
    const okButton = h('button', `dialog-button ok${danger ? ' danger' : ''}`, okLabel);
    if (cancelLabel !== null) {
      const cancelButton = h('button', 'dialog-button', cancelLabel);
      cancelButton.addEventListener('click', () => finish(false), { signal: done.signal });
      buttons.append(cancelButton);
    }
    okButton.addEventListener('click', () => finish(true), { signal: done.signal });
    buttons.append(okButton);
    box.append(buttons);
    backdrop.append(box);
    document.body.append(backdrop);
    // The buttons take no focus from a click, so Enter and Space always mean yes.
    box.addEventListener('mousedown', (e) => (e.target as HTMLElement).closest('button') && e.preventDefault(), { signal: done.signal });
    box.focus();

    function finish(answer: boolean) {
      done.abort();
      backdrop.remove();
      if (previous?.isConnected) previous.focus();
      resolve(answer);
    }

    window.addEventListener(
      'keydown',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        // A held key that opened the dialog must not answer it as well.
        if (e.repeat) return;
        if (e.key === 'Enter' || e.key === ' ') finish(true);
        else if (e.key === 'Escape') finish(cancelLabel === null);
      },
      { capture: true, signal: done.signal },
    );
    // Clicking beside a notice closes it; a question needs an answer.
    backdrop.addEventListener('mousedown', (e) => e.target === backdrop && cancelLabel === null && finish(true), { signal: done.signal });
  });
}
