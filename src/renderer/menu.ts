import { h, iconEl } from './dom';
import { ICONS } from './icons';

// Menus drawn by the app in its own style instead of macOS's native ones: every right-click menu and
// the lists the dropdown buttons open. One menu is open at a time. It takes the keyboard while it is
// open (arrows, Enter, Esc, typing the start of a label) without moving the focus, so the terminal
// that had it keeps it afterwards. A click outside closes it without reaching what is under it; a
// right-click outside opens that spot's own menu instead.

export interface MenuItem {
  label: string;
  /** What the menu resolves with when the item is chosen; items with a submenu need none. */
  id?: string;
  enabled?: boolean;
  /** Draws a check mark, as on a dropdown's current choice; items that leave it out get none. */
  checked?: boolean;
  /** CSS colour of a dot drawn before the label. */
  swatch?: string;
  /** Loses data, so it is drawn in red. */
  danger?: boolean;
  submenu?: MenuEntry[];
}

export type MenuEntry = MenuItem | 'separator';

/** Where the menu opens: at a point (a right-click), or dropping down from an element. */
export type MenuAnchor = { x: number; y: number } | HTMLElement;

interface Level {
  el: HTMLElement;
  items: Array<{ item: MenuItem; el: HTMLElement }>;
  /** Highlighted item, -1 for none. */
  index: number;
  child?: Level;
  /** The parent's item this submenu belongs to. */
  from?: number;
}

/** Room kept between a menu and the window's edge. */
const MARGIN = 6;
/** How long the pointer rests on an item before its submenu opens, or the open one closes. */
const SUBMENU_DELAY = 160;
/** How long typed letters add up to one search. */
const TYPE_AHEAD = 700;

let dismiss: (() => void) | null = null;

const enabled = (item: MenuItem) => item.enabled !== false;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** Closes the open menu, if any, as if it was dismissed. */
export function closeMenu() {
  dismiss?.();
}

/** Opens a menu and resolves with the chosen item's id, or null when it is dismissed. */
export function showMenu(entries: MenuEntry[], at: MenuAnchor): Promise<string | null> {
  closeMenu();
  return new Promise((resolve) => {
    const done = new AbortController();
    const backdrop = h('div', 'menu-backdrop');
    const openedAt = performance.now();
    let hoverTimer = 0;
    let typed = '';
    let typedAt = 0;

    const finish = (id: string | null) => {
      done.abort();
      clearTimeout(hoverTimer);
      backdrop.remove();
      dismiss = null;
      resolve(id);
    };
    dismiss = () => finish(null);

    const highlight = (level: Level, index: number) => {
      level.items[level.index]?.el.classList.remove('active');
      level.index = index;
      const row = level.items[index]?.el;
      row?.classList.add('active');
      row?.scrollIntoView({ block: 'nearest' });
    };

    const closeSub = (level: Level) => {
      if (!level.child) return;
      closeSub(level.child);
      level.child.el.remove();
      level.child = undefined;
    };

    const openSub = (level: Level, index: number): Level => {
      if (level.child?.from === index) return level.child;
      closeSub(level);
      const row = level.items[index].el;
      const child = build(level.items[index].item.submenu ?? []);
      child.from = index;
      level.child = child;
      backdrop.append(child.el);
      placeBeside(child.el, row);
      return child;
    };

    /** Chooses an item; one with a submenu opens it, and from the keyboard highlights its first item. */
    const activate = (level: Level, index: number, byKey: boolean) => {
      const { item } = level.items[index];
      if (!enabled(item)) return;
      if (!item.submenu) return finish(item.id ?? null);
      const child = openSub(level, index);
      if (byKey) move(child, 1);
    };

    const move = (level: Level, dir: 1 | -1) => {
      const n = level.items.length;
      let i = level.index;
      for (let k = 0; k < n; k++) {
        i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
        if (enabled(level.items[i].item)) return highlight(level, i);
      }
    };

    const hover = (level: Level, index: number) => {
      const { item } = level.items[index];
      // macOS highlights only what can be chosen.
      highlight(level, enabled(item) ? index : -1);
      clearTimeout(hoverTimer);
      // Waiting a moment lets the pointer cross other items on its way into an open submenu.
      hoverTimer = window.setTimeout(() => (item.submenu && enabled(item) ? openSub(level, index) : closeSub(level)), SUBMENU_DELAY);
    };

    function build(list: MenuEntry[]): Level {
      const el = h('div', 'menu');
      el.setAttribute('role', 'menu');
      const level: Level = { el, items: [], index: -1 };
      if (list.some((e) => e !== 'separator' && e.checked !== undefined)) el.classList.add('checks');
      for (const entry of list) {
        if (entry === 'separator') {
          // A separator at either end or next to another one separates nothing.
          if (el.lastElementChild?.classList.contains('menu-item')) el.append(h('div', 'menu-sep'));
          continue;
        }
        const row = h('div', 'menu-item');
        row.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
        if (!enabled(entry)) {
          row.classList.add('disabled');
          row.setAttribute('aria-disabled', 'true');
        }
        if (entry.danger) row.classList.add('danger');
        row.append(iconEl(entry.checked ? ICONS.check : '', 'menu-check'));
        if (entry.swatch) {
          const dot = h('span', 'menu-swatch');
          dot.style.background = entry.swatch;
          row.append(dot);
        }
        row.append(h('span', 'menu-label', entry.label));
        if (entry.submenu) row.append(iconEl(ICONS.chevronRight, 'menu-arrow'));
        el.append(row);
        const index = level.items.length;
        level.items.push({ item: entry, el: row });
        row.addEventListener('mouseenter', () => hover(level, index));
        row.addEventListener('mouseup', (e) => {
          // The release of the right-click that opened the menu is not a choice.
          if (e.button === 2 && performance.now() - openedAt < 300) return;
          activate(level, index, false);
        });
      }
      if (el.lastElementChild?.classList.contains('menu-sep')) el.lastElementChild.remove();
      el.addEventListener('mouseleave', () => level.child || highlight(level, -1));
      // Keeps the focus, and with it the caret, where it was.
      el.addEventListener('mousedown', (e) => e.preventDefault());
      return level;
    }

    const root = build(entries);
    backdrop.append(root.el);
    document.body.append(backdrop);
    place(root.el, at);
    // A dropdown opens on its current choice.
    if (at instanceof HTMLElement) {
      const current = root.items.findIndex((i) => i.item.checked);
      if (current >= 0) highlight(root, current);
    }

    /** The level the keys act on: the deepest one with a highlighted item. */
    const keyLevel = () => {
      let level = root;
      while (level.child && level.child.index >= 0) level = level.child;
      return level;
    };
    const parentOf = (level: Level) => {
      let p: Level | undefined = root;
      while (p && p.child !== level) p = p.child;
      return p;
    };

    window.addEventListener(
      'keydown',
      (e) => {
        // A shortcut goes on to the app, and the menu makes way for it.
        if (e.metaKey) return finish(null);
        e.preventDefault();
        e.stopPropagation();
        const level = keyLevel();
        const parent = parentOf(level);
        switch (e.key) {
          case 'ArrowDown':
          case 'ArrowUp':
            closeSub(level);
            return move(level, e.key === 'ArrowDown' ? 1 : -1);
          case 'ArrowRight':
            if (level.items[level.index]?.item.submenu) activate(level, level.index, true);
            return;
          case 'ArrowLeft':
            if (parent) closeSub(parent);
            return;
          case 'Escape':
            return parent ? closeSub(parent) : finish(null);
          case 'Enter':
          case ' ':
            if (level.index >= 0) activate(level, level.index, true);
            return;
        }
        if (e.key.length !== 1 || e.ctrlKey || e.altKey) return;
        const now = performance.now();
        typed = now - typedAt < TYPE_AHEAD ? typed + e.key.toLowerCase() : e.key.toLowerCase();
        typedAt = now;
        // A repeated first letter steps through the items starting with it.
        const from = typed.length === 1 ? level.index + 1 : Math.max(level.index, 0);
        const n = level.items.length;
        for (let k = 0; k < n; k++) {
          const i = (from + k) % n;
          const { item } = level.items[i];
          if (enabled(item) && item.label.toLowerCase().startsWith(typed)) {
            closeSub(level);
            return highlight(level, i);
          }
        }
      },
      { capture: true, signal: done.signal },
    );

    backdrop.addEventListener(
      'mousedown',
      (e) => {
        if (e.target !== backdrop) return;
        e.preventDefault();
        if (e.button !== 2 && !e.ctrlKey) finish(null);
      },
      { signal: done.signal },
    );
    backdrop.addEventListener(
      'contextmenu',
      (e) => {
        e.preventDefault();
        if (e.target !== backdrop) return;
        finish(null);
        // A right-click elsewhere opens that spot's menu, as it does with the macOS menus.
        document
          .elementFromPoint(e.clientX, e.clientY)
          ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 2 }));
      },
      { signal: done.signal },
    );
    backdrop.addEventListener('wheel', (e) => e.target === backdrop && finish(null), { signal: done.signal, passive: true });
    window.addEventListener('blur', () => finish(null), { signal: done.signal });
    window.addEventListener('resize', () => finish(null), { signal: done.signal });
  });
}

function place(el: HTMLElement, at: MenuAnchor) {
  let x: number;
  let y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    // A dropdown's list is at least as wide as its button.
    el.style.minWidth = `${Math.max(r.width, 120)}px`;
    x = r.left;
    y = r.bottom + 4;
    if (y + el.offsetHeight > innerHeight - MARGIN && r.top - 4 - el.offsetHeight >= MARGIN) y = r.top - 4 - el.offsetHeight;
  } else {
    // Like macOS: below and right of the pointer, flipped where the window ends.
    x = at.x + el.offsetWidth > innerWidth - MARGIN ? at.x - el.offsetWidth : at.x;
    y = at.y + el.offsetHeight > innerHeight - MARGIN ? at.y - el.offsetHeight : at.y;
  }
  el.style.left = `${clamp(x, MARGIN, innerWidth - MARGIN - el.offsetWidth)}px`;
  el.style.top = `${clamp(y, MARGIN, innerHeight - MARGIN - el.offsetHeight)}px`;
}

/** Puts a submenu beside its item, its first item level with it, on the left if the right has no room. */
function placeBeside(el: HTMLElement, row: HTMLElement) {
  const r = row.getBoundingClientRect();
  const menu = row.parentElement!.getBoundingClientRect();
  const first = el.querySelector<HTMLElement>('.menu-item');
  const inset = first ? first.offsetTop : 0;
  let x = menu.right - 2;
  if (x + el.offsetWidth > innerWidth - MARGIN) x = menu.left - el.offsetWidth + 2;
  el.style.left = `${clamp(x, MARGIN, innerWidth - MARGIN - el.offsetWidth)}px`;
  el.style.top = `${clamp(r.top - inset, MARGIN, innerHeight - MARGIN - el.offsetHeight)}px`;
}

/**
 * Turns a button into a dropdown that picks one of `options` from an in-app menu, in place of a
 * native `<select>`. `set` changes the shown value without calling `onChange`.
 */
export function dropdown<T extends string>(button: HTMLElement, options: Array<[value: T, label: string]>, onChange: (value: T) => void) {
  let value = options[0][0];
  const label = h('span', 'dropdown-label');
  button.classList.add('dropdown');
  button.replaceChildren(label, iconEl(ICONS.chevronDown, 'dropdown-arrow'));
  const paint = () => (label.textContent = options.find(([v]) => v === value)?.[1] ?? value);
  const open = async () => {
    button.classList.add('open');
    const choice = await showMenu(
      options.map(([v, text]) => ({ label: text, id: v, checked: v === value })),
      button,
    );
    button.classList.remove('open');
    if (choice === null || choice === value) return;
    value = choice as T;
    paint();
    onChange(value);
  };
  button.addEventListener('click', () => void open());
  button.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    void open();
  });
  paint();
  return {
    set(v: T) {
      value = v;
      paint();
    },
  };
}
