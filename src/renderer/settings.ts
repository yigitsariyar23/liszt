import type { LisztApi } from '../main/preload';
import { SHORTCUTS, shortcutFor, shortcutLabel, type ShortcutDef } from '../shared/shortcuts';
import type { Settings } from '../shared/types';
import { h, iconEl } from './dom';
import { ICONS } from './icons';

// The Settings screen: a sheet over the window with the project folders whose every folder is a
// pinned project, where the projects are listed, how a new Claude session opens, and the shortcuts. Every change is saved at once;
// the main process keeps the settings and rebuilds the menu with the new shortcuts.

export interface SettingsHost {
  api: LisztApi;
  projectList: () => 'tabs' | 'sidebar';
  setProjectList: (list: 'tabs' | 'sidebar') => void;
  /** Called after each saved change, so the app can pick up the new folders and shortcuts. */
  changed: (settings: Settings) => void;
}

let openSheet: HTMLElement | null = null;

const tilde = (dir: string, home: string) => (home && dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir);

export async function openSettings(host: SettingsHost) {
  if (openSheet) return;
  let settings = await host.api.settings();
  // The home folder, worked out from where the default folders sit, to shorten paths with ~.
  const home = settings.projectFolders.map((d) => /^(\/Users\/[^/]+)\//.exec(d)?.[1]).find(Boolean) ?? '';
  let recordingId: string | null = null;
  // Bumped by each recording, so one that a newer click cancelled does not end the newer one.
  let recordToken = 0;

  const backdrop = h('div', 'settings-backdrop');
  const sheet = h('div', 'settings');
  sheet.tabIndex = -1;
  const head = h('div', 'settings-head');
  const close = h('button', 'icon');
  close.innerHTML = ICONS.close;
  close.title = 'Close (Esc)';
  head.append(h('span', 'settings-title', 'Settings'), close);
  const body = h('div', 'settings-body');
  sheet.append(head, body);
  backdrop.append(sheet);
  document.body.append(backdrop);
  openSheet = backdrop;
  sheet.focus();

  const finish = () => {
    if (recordingId) host.api.cancelRecording();
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    openSheet = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || recordingId) return;
    e.preventDefault();
    e.stopPropagation();
    finish();
  };
  document.addEventListener('keydown', onKey, true);
  close.addEventListener('click', finish);
  backdrop.addEventListener('mousedown', (e) => e.target === backdrop && finish());

  const save = async (next: Settings) => {
    settings = await host.api.setSettings(next);
    host.changed(settings);
    render();
  };

  function section(title: string, note: string, ...content: HTMLElement[]): HTMLElement {
    const el = h('section', 'settings-section');
    el.append(h('div', 'settings-section-title', title), h('div', 'settings-note', note), ...content);
    return el;
  }

  function foldersSection(): HTMLElement {
    const list = h('div', 'settings-list');
    const folders = settings.projectFolders;
    folders.forEach((dir, i) => {
      const row = h('div', 'settings-row');
      const name = h('span', 'settings-path', tilde(dir, home));
      name.title = dir;
      const move = (to: number) => {
        const next = [...folders];
        next.splice(to, 0, ...next.splice(i, 1));
        void save({ ...settings, projectFolders: next });
      };
      const up = h('button', 'settings-small', '↑');
      up.title = 'Move up';
      up.disabled = i === 0;
      up.addEventListener('click', () => move(i - 1));
      const down = h('button', 'settings-small', '↓');
      down.title = 'Move down';
      down.disabled = i === folders.length - 1;
      down.addEventListener('click', () => move(i + 1));
      const remove = h('button', 'settings-small', 'Remove');
      remove.addEventListener('click', () => void save({ ...settings, projectFolders: folders.filter((d) => d !== dir) }));
      row.append(name, up, down, remove);
      list.append(row);
    });
    if (!folders.length) list.append(h('div', 'settings-empty', 'No project folders.'));
    const add = h('button', 'secondary', 'Add Folder…');
    add.addEventListener('click', async () => {
      const dir = await host.api.pickFolder();
      if (dir && !folders.includes(dir)) void save({ ...settings, projectFolders: [...folders, dir] });
    });
    return section(
      'Project folders',
      'Every folder inside these is opened as a pinned project that cannot be closed, grouped by the folder it is in, in this order. Git worktrees, hidden and _-prefixed folders, archive and studio are skipped. Removing a folder leaves its projects open as ordinary ones.',
      list,
      add,
    );
  }

  function viewSection(): HTMLElement {
    const seg = h('div', 'seg');
    for (const [value, label] of [
      ['tabs', 'Tabs in the top bar'],
      ['sidebar', 'Tree in the left panel'],
    ] as const) {
      const b = h('button', host.projectList() === value ? 'on' : '', label);
      b.addEventListener('click', () => {
        host.setProjectList(value);
        render();
      });
      seg.append(b);
    }
    return section('Projects', 'Where the projects are listed. In the left panel they take the Sessions panel’s place.', seg);
  }

  function claudeSection(): HTMLElement {
    const seg = h('div', 'seg');
    for (const [value, label] of [
      ['terminal', 'Terminal'],
      ['chat', 'Chat'],
    ] as const) {
      const b = h('button', settings.claudeView === value ? 'on' : '', label);
      b.addEventListener('click', () => void save({ ...settings, claudeView: value }));
      seg.append(b);
    }
    return section(
      'New Claude sessions',
      'How a new Claude session opens: in Claude Code’s own terminal UI, or as Liszt’s chat. Either can be switched to the other later.',
      seg,
    );
  }

  function shortcutsSection(): HTMLElement {
    // Which commands share a shortcut, so the clash can be shown on each of them.
    const users = new Map<string, ShortcutDef[]>();
    for (const def of SHORTCUTS) {
      const label = shortcutLabel(shortcutFor(def.id, settings.shortcuts));
      if (label) users.set(label, [...(users.get(label) ?? []), def]);
    }
    const table = h('div', 'settings-keys');
    let lastSection = '';
    for (const def of SHORTCUTS) {
      if (def.section !== lastSection) {
        lastSection = def.section;
        table.append(h('div', 'settings-keys-group', def.section));
      }
      const accel = shortcutFor(def.id, settings.shortcuts);
      const label = shortcutLabel(accel);
      const clash = (users.get(label) ?? []).filter((d) => d !== def);
      const row = h('div', `settings-key-row${clash.length ? ' clash' : ''}`);
      const name = h('span', 'settings-key-label', def.label);
      if (clash.length) name.append(h('span', 'settings-clash', `Same as ${clash.map((d) => d.label.toLowerCase()).join(', ')}`));
      const key = h('button', `settings-key${recordingId === def.id ? ' recording' : ''}`, recordingId === def.id ? 'Press keys…' : label || 'None');
      key.title = 'Click, then press the new shortcut. Esc cancels, ⌫ removes it.';
      key.addEventListener('click', async () => {
        const token = ++recordToken;
        if (recordingId) host.api.cancelRecording();
        recordingId = def.id;
        render();
        const got = await host.api.recordShortcut();
        if (token !== recordToken) return;
        recordingId = null;
        if (got === null) return render();
        const shortcuts = { ...settings.shortcuts };
        if (got === def.default) delete shortcuts[def.id];
        else shortcuts[def.id] = got;
        void save({ ...settings, shortcuts });
      });
      row.append(name, key);
      if (def.id in settings.shortcuts) {
        const reset = iconEl(ICONS.close, 'settings-reset');
        reset.title = `Back to ${shortcutLabel(def.default) || 'none'}`;
        reset.addEventListener('click', () => {
          const shortcuts = { ...settings.shortcuts };
          delete shortcuts[def.id];
          void save({ ...settings, shortcuts });
        });
        row.append(reset);
      }
      table.append(row);
    }
    const resetAll = h('button', 'secondary', 'Reset All Shortcuts');
    resetAll.disabled = !Object.keys(settings.shortcuts).length;
    resetAll.addEventListener('click', () => void save({ ...settings, shortcuts: {} }));
    return section('Shortcuts', 'Click a shortcut, then press the new keys. They need ⌘, ⌃ or ⌥ (or a function key).', table, resetAll);
  }

  function render() {
    const scroll = body.scrollTop;
    body.replaceChildren(foldersSection(), viewSection(), claudeSection(), shortcutsSection());
    body.scrollTop = scroll;
  }
  render();
}
