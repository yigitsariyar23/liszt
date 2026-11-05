import { h } from './dom';

// A small label under a button while the pointer rests on it: what it does and its shortcut. It
// stands in for a title tooltip, which macOS does not show over the window's drag area.

const tip = h('div', 'tip');
let timer: ReturnType<typeof setTimeout> | undefined;

/** Shows `text()` and, when there is one, `key()` under `el` after a moment of hovering. */
export function hoverTip(el: HTMLElement, text: () => string, key: () => string = () => '') {
  el.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!el.isConnected || !el.matches(':hover')) return;
      const k = key();
      tip.replaceChildren(h('span', 'tip-text', text()), ...(k ? [h('kbd', 'tip-key', k)] : []));
      if (!tip.isConnected) document.body.append(tip);
      tip.classList.add('open');
      const box = el.getBoundingClientRect();
      const own = tip.getBoundingClientRect();
      tip.style.left = `${Math.max(6, Math.min(box.left + box.width / 2 - own.width / 2, window.innerWidth - own.width - 6))}px`;
      tip.style.top = `${box.bottom + 6}px`;
    }, 400);
  });
  const hide = () => {
    clearTimeout(timer);
    tip.classList.remove('open');
  };
  el.addEventListener('mouseleave', hide);
  el.addEventListener('mousedown', hide);
}
