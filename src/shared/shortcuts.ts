// The shortcuts the Settings screen can change. Each is a menu command; the main process builds the
// menu from these with the user's choices laid over the defaults. Accelerators use Electron's
// spelling (`CmdOrCtrl+Shift+T`); an empty one means the command has no shortcut.

export interface ShortcutDef {
  id: string;
  label: string;
  section: 'Sessions' | 'Projects' | 'Panels' | 'Text' | 'Settings';
  default: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'new-claude', label: 'New Claude session', section: 'Sessions', default: 'CmdOrCtrl+T' },
  { id: 'new-shell', label: 'New shell', section: 'Sessions', default: 'CmdOrCtrl+Shift+T' },
  { id: 'new-agent', label: 'New agent session', section: 'Sessions', default: 'CmdOrCtrl+Alt+T' },
  { id: 'split-right', label: 'Split right with a new session', section: 'Sessions', default: 'CmdOrCtrl+D' },
  { id: 'split-down', label: 'Split down with a new session', section: 'Sessions', default: 'CmdOrCtrl+Shift+D' },
  { id: 'close-pane', label: 'Close session', section: 'Sessions', default: 'CmdOrCtrl+W' },
  { id: 'undo-delete', label: 'Undo delete, while its notice is shown', section: 'Sessions', default: 'CmdOrCtrl+Alt+Z' },
  { id: 'next-pane', label: 'Next session', section: 'Sessions', default: 'CmdOrCtrl+]' },
  { id: 'prev-pane', label: 'Previous session', section: 'Sessions', default: 'CmdOrCtrl+[' },
  { id: 'toggle-view', label: 'Switch chat / terminal', section: 'Sessions', default: 'CmdOrCtrl+E' },
  { id: 'new-project', label: 'New project', section: 'Projects', default: 'Ctrl+N' },
  { id: 'quick-chat', label: 'Quick chat, outside any project', section: 'Projects', default: 'CmdOrCtrl+Shift+N' },
  { id: 'add-project', label: 'Add project', section: 'Projects', default: 'CmdOrCtrl+O' },
  { id: 'close-project', label: 'Close project', section: 'Projects', default: 'CmdOrCtrl+Shift+W' },
  { id: 'next-project', label: 'Next project', section: 'Projects', default: 'CmdOrCtrl+Shift+]' },
  { id: 'prev-project', label: 'Previous project', section: 'Projects', default: 'CmdOrCtrl+Shift+[' },
  { id: 'toggle-project-list', label: 'Projects in tabs / sidebar', section: 'Projects', default: 'CmdOrCtrl+Shift+L' },
  { id: 'toggle-sidebar', label: 'Changes panel', section: 'Panels', default: 'CmdOrCtrl+B' },
  { id: 'toggle-sessions', label: 'Sessions panel', section: 'Panels', default: 'CmdOrCtrl+L' },
  { id: 'toggle-tasks', label: 'Tasks panel', section: 'Panels', default: 'CmdOrCtrl+J' },
  { id: 'font-up', label: 'Bigger text', section: 'Text', default: 'CmdOrCtrl+=' },
  { id: 'font-down', label: 'Smaller text', section: 'Text', default: 'CmdOrCtrl+-' },
  { id: 'font-reset', label: 'Actual size', section: 'Text', default: 'CmdOrCtrl+0' },
  { id: 'settings', label: 'Settings', section: 'Settings', default: 'CmdOrCtrl+,' },
];

/** The accelerator a command runs on: the user's choice, else its default. */
export function shortcutFor(id: string, chosen: Record<string, string>): string {
  return chosen[id] ?? SHORTCUTS.find((s) => s.id === id)?.default ?? '';
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '=',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Enter: 'Return',
  Tab: 'Tab',
  Space: 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/** The accelerator key for a physical key (`KeyboardEvent.code`), or undefined for a bare modifier. */
export function codeKey(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  return CODE_KEYS[code];
}

export interface KeyPress {
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

/** The accelerator a key press spells, or undefined when it is only modifiers. */
export function acceleratorOf(k: KeyPress): string | undefined {
  const key = codeKey(k.code);
  if (!key) return undefined;
  const mods = [k.meta && 'CmdOrCtrl', k.control && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift'].filter(Boolean);
  return [...mods, key].join('+');
}

/** Whether a key press is the given accelerator. */
export function matchesAccelerator(accelerator: string, k: KeyPress): boolean {
  return Boolean(accelerator) && normalize(accelerator) === normalize(acceleratorOf(k) ?? '');
}

function normalize(accelerator: string): string {
  const parts = accelerator.split('+').map((p) => (p === 'Cmd' || p === 'Command' ? 'CmdOrCtrl' : p === 'Control' ? 'Ctrl' : p === 'Option' ? 'Alt' : p));
  const key = parts.pop() ?? '';
  return [...['CmdOrCtrl', 'Ctrl', 'Alt', 'Shift'].filter((m) => parts.includes(m)), key.length === 1 ? key.toUpperCase() : key].join('+');
}

const KEY_SYMBOLS: Record<string, string> = {
  Return: '↩',
  Tab: '⇥',
  Space: 'Space',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: '⎋',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
};

/** An accelerator as macOS menus show it: `CmdOrCtrl+Shift+T` → ⇧⌘T. */
export function shortcutLabel(accelerator: string): string {
  if (!accelerator) return '';
  const parts = normalize(accelerator).split('+');
  const key = parts.pop() ?? '';
  const mods = [
    parts.includes('Ctrl') ? '⌃' : '',
    parts.includes('Alt') ? '⌥' : '',
    parts.includes('Shift') ? '⇧' : '',
    parts.includes('CmdOrCtrl') ? '⌘' : '',
  ];
  return mods.join('') + (KEY_SYMBOLS[key] ?? key);
}
