import { h } from './dom';

// Notices in the bottom right corner that offer to undo what was just done. Each one waits its time
// and then lets the action go through; the pointer over it holds the clock, and its bar shows what
// is left. Undo calls back instead, and the × lets the action go through at once. Several stack up,
// the newest at the bottom. Undo Delete's shortcut clicks the newest one's Undo (see undoNewest).

export interface UndoToast {
  /** What was done, such as `Deleted 3 sessions`. */
  message: string;
  /** Puts it back. */
  undo: () => void;
  /** The time to undo is over; runs once, unless Undo was clicked. */
  expire: () => void;
  /** The shortcut that undoes it, as menus show it, for the button's tooltip. */
  key?: string;
  /** How long Undo is offered. */
  ms?: number;
}

let stack: HTMLElement | undefined;
/** The Undo of each notice on screen, oldest first. */
const open: Array<() => void> = [];

/** Undoes what the newest notice on screen offers to; false when none is shown. */
export function undoNewest(): boolean {
  const undo = open.at(-1);
  undo?.();
  return Boolean(undo);
}

export function undoToast({ message, undo, expire, key, ms = 10_000 }: UndoToast) {
  if (!stack?.isConnected) {
    stack = h('div', 'toasts');
    document.body.append(stack);
  }
  const el = h('div', 'toast');
  el.setAttribute('role', 'status');
  const undoButton = h('button', 'toast-undo', 'Undo');
  if (key) undoButton.title = `Undo (${key})`;
  const closeButton = h('button', 'toast-close', '×');
  closeButton.title = 'Dismiss';
  const bar = h('div', 'toast-bar');
  bar.style.animationDuration = `${ms}ms`;
  el.append(h('span', 'toast-text', message), undoButton, closeButton, bar);
  stack.append(el);

  let left = ms;
  let started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => finish(false), left);
  let done = false;
  const undoIt = () => finish(true);
  open.push(undoIt);

  function finish(undone: boolean) {
    if (done) return;
    done = true;
    open.splice(open.indexOf(undoIt), 1);
    clearTimeout(timer);
    el.remove();
    if (undone) undo();
    else expire();
  }

  el.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    timer = undefined;
    left -= Date.now() - started;
  });
  el.addEventListener('mouseleave', () => {
    if (done || timer) return;
    started = Date.now();
    timer = setTimeout(() => finish(false), Math.max(left, 1500));
  });
  // The buttons take no focus, so a terminal keeps its keys.
  el.addEventListener('mousedown', (e) => e.preventDefault());
  undoButton.addEventListener('click', undoIt);
  closeButton.addEventListener('click', () => finish(false));
}
