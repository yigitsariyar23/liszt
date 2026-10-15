import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import type { LisztApi } from '../main/preload';
import type {
  AgentSession,
  AppSession,
  AppState,
  GitInfo,
  GitResult,
  HookEvent,
  LayoutNode,
  PaneKind,
  PaneState,
  ProjectState,
  SessionFilter,
  SessionSort,
  SidebarView,
  TaskState,
  TaskStatus,
} from '../shared/types';
import { ICONS, KIND_GLYPH } from './icons';
import { leaf, panesIn, removePane, replacePane, splitPane, type Side } from './layout';

declare global {
  interface Window {
    liszt: LisztApi;
  }
}

const api = window.liszt;

type Status = 'starting' | 'idle' | 'running' | 'attention' | 'exited';
type DropZone = Side | 'center';

interface PaneView {
  pane: PaneState;
  project: ProjectState;
  el: HTMLElement;
  titleEl: HTMLElement;
  chipEl: HTMLElement;
  actionsEl: HTMLElement;
  dropEl: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  status: Status;
  since: number;
  spawned: boolean;
  exitCode: number | null;
  /** Last thing the session did, for the Sessions overview. */
  activity: string;
  /** Tool calls in the current turn. */
  actions: number;
  /** Running `claude attach` on a background session, whose hooks may not reach this pane. */
  attached: boolean;
  /** A hook arrived since the last spawn, so hooks drive the status. */
  hooked: boolean;
}

interface PaneOptions {
  cwd?: string;
  taskId?: string;
  branch?: string;
  title?: string;
  /** First prompt of a new Claude session. */
  prompt?: string;
  /** Resume this Claude session instead of starting a new one. */
  sessionId?: string;
  /** Attach to this background session (the short id), resuming `sessionId` once it has stopped. */
  bgId?: string;
  /** Show the new session in the focused tile (default) or keep it as a background tab. */
  show?: boolean;
  /** Open it in a new tile on this side of the focused one. */
  split?: Side;
  focus?: boolean;
}

const DEFAULT_FONT_SIZE = 13;
const FONT = '"JetBrains Mono", "SF Mono", SFMono-Regular, Menlo, monospace';
const DRAG_TYPE = 'application/x-liszt-pane';
const THEME = {
  background: '#111113',
  foreground: '#d8d8dc',
  cursor: '#e07a4f',
  cursorAccent: '#111113',
  selectionBackground: '#3a3a44',
  black: '#1d1d21',
  red: '#e36d6d',
  green: '#6cc287',
  yellow: '#e2b84f',
  blue: '#6fa3e6',
  magenta: '#c58fe0',
  cyan: '#5fc4c4',
  white: '#c9c9cf',
  brightBlack: '#5c5c66',
  brightRed: '#f28b8b',
  brightGreen: '#8ad6a2',
  brightYellow: '#f0cd70',
  brightBlue: '#8fbaf0',
  brightMagenta: '#d6a9ec',
  brightCyan: '#82d8d8',
  brightWhite: '#f2f2f5',
};

let state: AppState = {
  version: 1,
  projects: [],
  activeProjectId: null,
  sidebar: 'changes',
  tasksPanel: true,
  fontSize: DEFAULT_FONT_SIZE,
  sessionFilter: 'active',
  sessionSort: 'status',
  sessionMarks: {},
};
const views = new Map<string, PaneView>();
const stages = new Map<string, HTMLElement>();
let focusedPaneId: string | null = null;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const tabsEl = byId('tabs');
const sessionBarEl = byId('sessionbar');
const workspaceEl = byId('workspace');
const poolEl = byId('pool');
const gitEl = byId('git');
const emptyEl = byId('empty');
const sideProjectEl = byId('side-project');
const sidebarBtn = byId('toggle-sidebar');
const sessionsBtn = byId('toggle-sessions');
const tasksBtn = byId('toggle-tasks');
const taskListEl = byId('task-list');
const taskInput = byId<HTMLInputElement>('task-input');
const tasksProjectEl = byId('tasks-project');
const apOffBtn = byId('ap-off');
const apOnBtn = byId('ap-on');
const apLimit = byId<HTMLSelectElement>('ap-limit');
const sessionListEl = byId('session-list');
const sessionsCountEl = byId('sessions-count');
const sessionSearch = byId<HTMLInputElement>('session-search');
const sessionFilterEl = byId<HTMLSelectElement>('session-filter');
const sessionSortEl = byId<HTMLSelectElement>('session-sort');

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function iconEl(svg: string, cls: string): HTMLElement {
  const el = h('span', cls);
  el.innerHTML = svg;
  return el;
}

const uuid = () => crypto.randomUUID();
const activeProject = () => state.projects.find((p) => p.id === state.activeProjectId) ?? null;
const displayTitle = (v: PaneView) => v.pane.customTitle || v.pane.title || (v.pane.kind === 'claude' ? 'New session' : 'shell');
const taskOf = (v: PaneView) => (v.pane.taskId ? v.project.tasks.find((t) => t.id === v.pane.taskId) : undefined);
const isVisible = (v: PaneView) => panesIn(v.project.layout).includes(v.pane.id);

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  if (hours < 24) return `${hours}h ${m % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function hue(text: string): number {
  let n = 0;
  for (const ch of text) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => api.saveState(state), 200);
}
window.addEventListener('beforeunload', () => api.saveState(state));

// --- Keys --------------------------------------------------------------------------------------
// Option stays a plain modifier so layouts that type @, [ or | with it keep working; the few
// readline moves people expect from a macOS terminal are mapped by hand instead.

const KEYMAP: Array<[(e: KeyboardEvent) => boolean, string]> = [
  [(e) => e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey, '\x1b\r'], // newline in Claude's prompt
  [(e) => e.key === 'ArrowLeft' && e.metaKey, '\x01'],
  [(e) => e.key === 'ArrowRight' && e.metaKey, '\x05'],
  [(e) => e.key === 'Backspace' && e.metaKey, '\x15'],
  [(e) => e.key === 'ArrowLeft' && e.altKey && !e.metaKey, '\x1bb'],
  [(e) => e.key === 'ArrowRight' && e.altKey && !e.metaKey, '\x1bf'],
  [(e) => e.key === 'Backspace' && e.altKey && !e.metaKey, '\x17'],
];

function handleKey(v: PaneView, e: KeyboardEvent): boolean {
  const hit = KEYMAP.find(([match]) => match(e));
  if (!hit) return true;
  if (e.type === 'keydown') api.write(v.pane.id, hit[1]);
  e.preventDefault();
  return false;
}

// --- Panes -------------------------------------------------------------------------------------

function createView(project: ProjectState, pane: PaneState): PaneView {
  const el = h('section', `pane ${pane.kind}`);
  const head = h('header', 'pane-head');
  head.draggable = true;
  const titleEl = h('span', 'title');
  const chipEl = h('span', 'chip');
  const actionsEl = h('span', 'pane-actions');
  const unsplitBtn = iconEl(ICONS.unsplit, 'icon unsplit');
  unsplitBtn.title = 'Take out of the split (the session keeps running as a tab)';
  const closeBtn = iconEl(ICONS.close, 'icon');
  closeBtn.title = 'Close session (⌘W)';
  head.append(iconEl(pane.kind === 'claude' ? ICONS.claude : ICONS.shell, 'pane-kind'), titleEl);
  if (pane.branch) {
    const branch = h('span', 'branch-tag', `⎇ ${pane.branch}`);
    branch.title = pane.cwd ?? '';
    head.append(branch);
  }
  head.append(chipEl, actionsEl, unsplitBtn, closeBtn);
  const body = h('div', 'pane-body');
  const host = h('div', 'term-host');
  body.append(host);
  const dropEl = h('div', 'drop');
  dropEl.append(h('div', 'drop-zone'));
  el.append(head, body, dropEl);
  poolEl.append(el);

  const term = new Terminal({
    fontFamily: FONT,
    fontSize: state.fontSize,
    lineHeight: 1.15,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    macOptionClickForcesSelection: true,
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon((_e, uri) => api.openExternal(uri)));
  term.open(host);
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {
    // No WebGL: xterm keeps its DOM renderer.
  }

  const v: PaneView = {
    pane,
    project,
    el,
    titleEl,
    chipEl,
    actionsEl,
    dropEl,
    term,
    fit,
    status: 'starting',
    since: 0,
    spawned: false,
    exitCode: null,
    activity: '',
    actions: 0,
    attached: false,
    hooked: false,
  };
  views.set(pane.id, v);

  term.onData((data) => {
    api.write(pane.id, data);
    // Typing into a session reads it; the focus reports xterm sends when the window comes back do not.
    if (data !== '\x1b[I' && data !== '\x1b[O') setUnread(v, false);
  });
  // Claude names the task it is working on in the terminal title ("✳ Fix login crash").
  term.onTitleChange((raw) => {
    const clean = raw.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (!clean || clean === pane.title || /^claude( code)?$/i.test(clean)) return;
    pane.title = clean;
    renderTitle(v);
    save();
  });
  term.attachCustomKeyEventHandler((e) => handleKey(v, e));
  term.textarea?.addEventListener('focus', () => setFocused(v));
  el.addEventListener('mousedown', (e) => {
    setFocused(v);
    // A right-click opens the menu that can mark the session unread, so only a left click reads it.
    if (e.button === 0) setUnread(v, false);
  });
  closeBtn.addEventListener('click', () => closePane(v));
  unsplitBtn.addEventListener('click', () => unsplitPane(v));
  titleEl.addEventListener('dblclick', () => editTitle(v));
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void sessionMenu(v, 'head');
  });
  head.addEventListener('dragstart', (e) => beginDrag(e, pane.id));
  head.addEventListener('dragend', endDrag);
  dropEl.addEventListener('dragover', (e) => {
    if (!dragPaneId) return;
    e.preventDefault();
    dropEl.dataset.zone = zoneAt(dropEl, e);
  });
  dropEl.addEventListener('dragleave', () => delete dropEl.dataset.zone);
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const dragged = dragPaneId;
    // Measured before endDrag hides the overlay.
    const zone = zoneAt(dropEl, e);
    endDrag();
    if (dragged) dropOnPane(v.project, v.pane.id, dragged, zone);
  });
  new ResizeObserver(() => scheduleFit(v)).observe(host);

  renderTitle(v);
  renderChip(v);
  return v;
}

function scheduleFit(v: PaneView) {
  requestAnimationFrame(() => {
    // Background tabs and hidden projects measure as zero; they fit again once shown.
    if (!v.el.isConnected || v.el.offsetParent === null) return;
    try {
      v.fit.fit();
    } catch {
      return;
    }
    if (v.spawned) api.resize(v.pane.id, v.term.cols, v.term.rows);
  });
}

async function spawn(v: PaneView, resume: boolean, prompt?: string) {
  // A session id is only reused for --resume; a fresh start always gets a new one so it never
  // collides with an id claude has already seen.
  if (v.pane.kind === 'claude' && !resume) {
    v.pane.sessionId = uuid();
    v.pane.started = false;
    v.pane.bgId = undefined;
    save();
  }
  v.spawned = true;
  v.exitCode = null;
  v.attached = false;
  v.hooked = false;
  setStatus(v, v.pane.kind === 'claude' ? 'starting' : 'idle');
  try {
    v.fit.fit();
  } catch {
    // Not visible yet; the ResizeObserver resizes the pty once it is.
  }
  const res = await api.spawn({
    paneId: v.pane.id,
    cwd: v.pane.cwd ?? v.project.path,
    kind: v.pane.kind,
    sessionId: v.pane.sessionId,
    resume,
    cols: v.term.cols,
    rows: v.term.rows,
    prompt,
    transcript: v.pane.transcript,
    attach: resume ? v.pane.bgId : undefined,
  });
  if (res.ok && resume && !res.resumed) {
    v.pane.sessionId = res.sessionId;
    v.pane.started = false;
    v.pane.transcript = undefined;
    save();
  }
  if (res.ok) {
    v.attached = res.attached;
    if (v.pane.bgId && !res.attached) {
      v.pane.bgId = undefined;
      save();
    }
    if (res.attached) syncAttached(v);
  }
  if (!res.ok) {
    v.term.writeln(`\r\n\x1b[31mCould not start: ${res.error}\x1b[0m`);
    v.exitCode = -1;
    setStatus(v, 'exited');
  }
}

function restart(v: PaneView, resume: boolean) {
  v.term.reset();
  if (!resume) {
    v.pane.title = '';
    renderTitle(v);
  }
  void spawn(v, resume);
  v.term.focus();
}

function setStatus(v: PaneView, status: Status, keepSince = false) {
  if (!(keepSince && v.since)) v.since = Date.now();
  v.status = status;
  paintStatus(v);
}

/** Shows a session's status everywhere it appears. */
function paintStatus(v: PaneView) {
  renderChip(v);
  renderActions(v);
  paintSessionTab(v);
  renderTabs();
  renderTaskChips();
  renderSessions();
  updateBadge();
}

function renderTitle(v: PaneView) {
  if (!v.titleEl.isContentEditable) {
    v.titleEl.textContent = displayTitle(v);
    v.titleEl.title = `${displayTitle(v)}\n${v.pane.cwd ?? v.project.path}\nDouble-click to rename, right-click for more`;
  }
  paintSessionTab(v);
}

function chipText(v: PaneView): string {
  switch (v.status) {
    case 'running':
      return `Running · ${duration(Date.now() - v.since)}`;
    case 'attention':
      return 'Needs you';
    case 'idle':
      return isUnread(v) ? 'Unread' : 'Idle';
    case 'exited':
      return v.exitCode ? `Exited (${v.exitCode})` : 'Exited';
    default:
      return 'Starting';
  }
}

const chipClass = (v: PaneView) => `chip ${isUnread(v) ? 'unread' : v.status}`;

function paintChip(el: HTMLElement, v: PaneView) {
  el.className = chipClass(v);
  el.textContent = chipText(v);
}

function renderChip(v: PaneView) {
  if (v.pane.kind === 'shell' && v.status !== 'exited' && !isUnread(v)) {
    v.chipEl.className = 'chip';
    v.chipEl.textContent = '';
    return;
  }
  paintChip(v.chipEl, v);
}

/**
 * A reply waits to be read: shown instead of Idle until the user goes to the session. Sessions of
 * projects not opened since launch have not started yet and show it too.
 */
const isUnread = (v: PaneView) => Boolean(v.pane.unread) && (v.status === 'idle' || !v.spawned);

const dotClass = (v: PaneView) => (isUnread(v) ? 'unread' : ['running', 'attention', 'exited'].includes(v.status) ? v.status : '');

/** The user is looking at this session right now, so a reply it gets is read as it arrives. */
const watching = (v: PaneView) => document.hasFocus() && state.activeProjectId === v.project.id && focusedPaneId === v.pane.id;

function setUnread(v: PaneView, unread: boolean) {
  if (Boolean(v.pane.unread) === unread) return;
  v.pane.unread = unread || undefined;
  paintStatus(v);
  save();
}

/** Claude ended its turn; the reply stays unread unless the user is watching the session. */
function finishTurn(v: PaneView) {
  if (!watching(v)) v.pane.unread = true;
  setStatus(v, 'idle');
}

function renderActions(v: PaneView) {
  v.actionsEl.replaceChildren();
  if (v.status !== 'exited') return;
  const button = (label: string, onClick: () => void) => {
    const b = h('button', undefined, label);
    b.addEventListener('click', onClick);
    v.actionsEl.append(b);
  };
  if (v.pane.kind === 'shell') {
    button('Restart', () => restart(v, false));
    return;
  }
  if (v.pane.started) button('Resume', () => restart(v, true));
  button('New session', () => restart(v, false));
}

/**
 * Lets the user retype a label in place. Enter or clicking away commits, Esc cancels; `onEnd` gets
 * the trimmed text, or null when cancelled.
 */
function editText(el: HTMLElement, text: string, onEnd: (text: string | null) => void) {
  // A draggable header or tab would turn selecting the text with the mouse into a drag.
  const handle = el.closest<HTMLElement>('[draggable="true"]');
  if (handle) handle.draggable = false;
  const done = new AbortController();
  el.contentEditable = 'true';
  el.textContent = text;
  el.focus();
  document.getSelection()?.selectAllChildren(el);
  const finish = (commit: boolean) => {
    done.abort();
    el.contentEditable = 'false';
    if (handle) handle.draggable = true;
    onEnd(commit ? (el.textContent?.trim() ?? '') : null);
  };
  el.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      finish(e.key === 'Enter');
      // Clicking away leaves focus where it went; the keyboard hands it back to the terminal.
      if (focusedPaneId) views.get(focusedPaneId)?.term.focus();
    },
    { signal: done.signal },
  );
  el.addEventListener('blur', () => finish(true), { signal: done.signal });
}

/** Renames a session in place, in its tile's header or in its tab. */
function editTitle(v: PaneView, el = v.titleEl) {
  editText(el, displayTitle(v), (text) => {
    if (text !== null) {
      v.pane.customTitle = text && text !== v.pane.title ? text : undefined;
      save();
    }
    renderTitle(v);
    renderSessions();
    if (sessionBarDirty) {
      sessionBarDirty = false;
      renderSessionBar();
    }
  });
}

function renameTab(v: PaneView) {
  const title = sessionTabEls.get(v.pane.id)?.querySelector<HTMLElement>('.stab-title');
  if (title) editTitle(v, title);
}

async function sessionMenu(v: PaneView, from: 'tab' | 'head') {
  const project = v.project;
  const visible = panesIn(project.layout);
  const anchor = splitAnchor(project);
  const choice = await api.sessionMenu({
    claude: v.pane.kind === 'claude',
    renamed: Boolean(v.pane.customTitle),
    canSplit: Boolean(anchor && anchor !== v.pane.id),
    inSplit: visible.length > 1 && visible.includes(v.pane.id),
    started: v.pane.started,
    others: project.panes.length > 1,
    unread: Boolean(v.pane.unread),
  });
  // The session may have been closed while the menu was open.
  if (views.get(v.pane.id) !== v) return;
  switch (choice) {
    case 'rename':
      return from === 'tab' ? renameTab(v) : editTitle(v);
    case 'unread':
      return setUnread(v, !v.pane.unread);
    case 'reset-name':
      v.pane.customTitle = undefined;
      renderTitle(v);
      renderSessions();
      return save();
    case 'split-right':
      return splitWith(v, 'right');
    case 'split-down':
      return splitWith(v, 'bottom');
    case 'unsplit':
      return unsplitPane(v);
    case 'reveal':
      return api.reveal(v.pane.cwd ?? project.path);
    case 'copy-id':
      return api.copy(v.pane.sessionId);
    case 'close':
      return void closePane(v);
    case 'close-others':
      for (const pane of [...project.panes]) {
        const other = views.get(pane.id);
        if (other && other !== v) closePane(other);
      }
      return;
  }
}

function setFocused(v: PaneView) {
  if (focusedPaneId === v.pane.id) return;
  if (focusedPaneId) views.get(focusedPaneId)?.el.classList.remove('focused');
  focusedPaneId = v.pane.id;
  v.project.activePaneId = v.pane.id;
  v.el.classList.add('focused');
  paintSessionTabs();
  save();
  // The Changes sidebar follows the focused session into its worktree.
  void refreshGit();
}

function focusPane(id: string | undefined) {
  const v = id ? views.get(id) : undefined;
  if (!v) return;
  setFocused(v);
  // Going to a session reads it; merely focusing the window again does not.
  setUnread(v, false);
  v.term.focus();
}

// --- Layout ------------------------------------------------------------------------------------
// Each project has a stage holding its split tree. Panes not in the tree wait in a hidden pool,
// still running, and come back when their tab is clicked or dragged onto the stage.

function ensureStage(project: ProjectState): HTMLElement {
  let stage = stages.get(project.id);
  if (stage) return stage;
  stage = h('div', 'stage');
  workspaceEl.append(stage);
  stages.set(project.id, stage);
  return stage;
}

function stagePlaceholder(project: ProjectState): HTMLElement {
  const empty = h('div', 'placeholder');
  empty.append(h('div', 'placeholder-title', project.name), h('p', undefined, project.path));
  const row = h('div', 'row');
  const claudeBtn = h('button', 'secondary', 'New Claude session · ⌘T');
  const shellBtn = h('button', 'secondary', 'New shell · ⇧⌘T');
  claudeBtn.addEventListener('click', () => addPane('claude', project));
  shellBtn.addEventListener('click', () => addPane('shell', project));
  row.append(claudeBtn, shellBtn);
  empty.append(row);
  return empty;
}

function renderLayout(project: ProjectState) {
  const stage = ensureStage(project);
  const hadFocus = stage.contains(document.activeElement);
  if (!project.layout && project.panes.length) project.layout = leaf(project.panes[0].id);
  for (const pane of project.panes) {
    const v = views.get(pane.id);
    if (v) poolEl.append(v.el);
  }
  const visible = panesIn(project.layout);
  stage.classList.toggle('solo', visible.length <= 1);
  stage.replaceChildren(project.layout ? buildNode(project, project.layout) : stagePlaceholder(project));
  for (const id of visible) {
    const v = views.get(id);
    if (v) scheduleFit(v);
  }
  if (hadFocus && focusedPaneId && visible.includes(focusedPaneId)) views.get(focusedPaneId)?.term.focus();
  if (project.id === state.activeProjectId) paintSessionTabs();
}

function buildNode(project: ProjectState, node: LayoutNode): HTMLElement {
  if (node.type === 'pane') {
    const slot = h('div', 'slot');
    const v = views.get(node.paneId);
    if (v) slot.append(v.el);
    return slot;
  }
  const box = h('div', `split ${node.dir}`);
  node.children.forEach((child, i) => {
    if (i > 0) box.append(gutter(project, node, i));
    const cell = buildNode(project, child);
    cell.style.flex = `${node.sizes[i]} 1 0`;
    box.append(cell);
  });
  return box;
}

function gutter(project: ProjectState, node: Extract<LayoutNode, { type: 'split' }>, i: number): HTMLElement {
  const g = h('div', 'gutter');
  g.title = 'Drag to resize, double-click to even out';
  g.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const row = node.dir === 'row';
    const rect = g.parentElement!.getBoundingClientRect();
    const total = row ? rect.width : rect.height;
    const start = row ? e.clientX : e.clientY;
    const [a0, b0] = [node.sizes[i - 1], node.sizes[i]];
    const prev = g.previousElementSibling as HTMLElement;
    const next = g.nextElementSibling as HTMLElement;
    document.body.classList.add(row ? 'resizing-col' : 'resizing-row');
    const move = (ev: MouseEvent) => {
      const delta = ((row ? ev.clientX : ev.clientY) - start) / total;
      const a = Math.min(a0 + b0 - 0.08, Math.max(0.08, a0 + delta));
      node.sizes[i - 1] = a;
      node.sizes[i] = a0 + b0 - a;
      prev.style.flexGrow = String(node.sizes[i - 1]);
      next.style.flexGrow = String(node.sizes[i]);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-col', 'resizing-row');
      save();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  g.addEventListener('dblclick', () => {
    node.sizes = node.sizes.map(() => 1 / node.sizes.length);
    renderLayout(project);
    save();
  });
  return g;
}

/** The tile new and revealed sessions go next to or in place of: the focused one if it is on stage. */
function splitAnchor(project: ProjectState): string | undefined {
  const visible = panesIn(project.layout);
  return project.activePaneId && visible.includes(project.activePaneId) ? project.activePaneId : visible[0];
}

/** Brings a session into view: focuses its tile, or shows it in place of the focused tile. */
function showPane(project: ProjectState, id: string, focus = true) {
  const visible = panesIn(project.layout);
  if (!visible.includes(id)) {
    const target = splitAnchor(project);
    project.layout = target && project.layout ? replacePane(project.layout, target, id) : leaf(id);
    renderLayout(project);
  }
  if (focus && project.id === state.activeProjectId) focusPane(id);
  save();
}

function revealPane(v: PaneView) {
  if (state.activeProjectId !== v.project.id) activateProject(v.project.id);
  showPane(v.project, v.pane.id);
}

/** Tiles a session next to the focused one, as dropping its tab on that tile's edge does. */
function splitWith(v: PaneView, side: Side) {
  const anchor = splitAnchor(v.project);
  if (anchor) dropOnPane(v.project, anchor, v.pane.id, side);
}

function unsplitPane(v: PaneView) {
  const project = v.project;
  if (panesIn(project.layout).length < 2) return;
  project.layout = removePane(project.layout, v.pane.id);
  renderLayout(project);
  focusPane(panesIn(project.layout)[0]);
  save();
}

function addPane(kind: PaneKind, project = activeProject(), opts: PaneOptions = {}): PaneView | undefined {
  if (!project) return;
  const resume = Boolean(opts.sessionId);
  const pane: PaneState = {
    id: uuid(),
    kind,
    sessionId: opts.sessionId ?? uuid(),
    started: resume,
    title: '',
    customTitle: opts.title,
    cwd: opts.cwd,
    taskId: opts.taskId,
    branch: opts.branch,
    bgId: opts.bgId,
  };
  // New tabs open next to the focused one, like a browser; task sessions line up at the end.
  const at = opts.taskId ? -1 : project.panes.findIndex((p) => p.id === project.activePaneId);
  project.panes.splice(at < 0 ? project.panes.length : at + 1, 0, pane);
  const v = createView(project, pane);

  const anchor = splitAnchor(project);
  if (opts.split && project.layout && anchor) {
    project.layout = splitPane(project.layout, anchor, pane.id, opts.split);
    renderLayout(project);
  } else if ((opts.show ?? true) || !project.layout) {
    showPane(project, pane.id, false);
  }

  const active = project.id === state.activeProjectId;
  // Task sessions start right away even in a background project, so Autopilot keeps working there.
  if (active || opts.taskId) void spawn(v, resume, opts.prompt);
  if (active && (opts.focus ?? true) && isVisible(v)) focusPane(pane.id);
  renderSessionBar();
  renderTabs();
  renderSessions();
  save();
  return v;
}

/**
 * Returns false when the user chose to keep a working session. `ask: false` skips that question when
 * the caller already asked; `stop: false` leaves a background session to the caller, which deletes it.
 */
function closePane(v: PaneView, { ask = true, stop = true } = {}): boolean {
  if (ask && (v.status === 'running' || v.status === 'attention') && !confirm(`"${displayTitle(v)}" is still working. Close it?`)) return false;
  const project = v.project;
  const index = project.panes.indexOf(v.pane);
  const visible = panesIn(project.layout);
  api.kill(v.pane.id);
  if (v.pane.kind === 'claude' && stop) api.stopBackground(v.pane.sessionId, v.pane.bgId);
  v.term.dispose();
  v.el.remove();
  views.delete(v.pane.id);
  project.panes = project.panes.filter((p) => p !== v.pane);
  if (visible.includes(v.pane.id)) {
    // Like closing a browser tab: the tile moves on to a neighbouring background session.
    const hidden = project.panes.filter((p) => !visible.includes(p.id));
    const next = hidden.find((p) => project.panes.indexOf(p) >= index) ?? hidden.at(-1);
    project.layout = next && project.layout ? replacePane(project.layout, v.pane.id, next.id) : removePane(project.layout, v.pane.id);
    renderLayout(project);
  }
  if (project.activePaneId === v.pane.id) project.activePaneId = undefined;
  if (focusedPaneId === v.pane.id) {
    focusedPaneId = null;
    if (project.id === state.activeProjectId) focusPane(panesIn(project.layout)[0]);
  }
  const task = taskOf(v);
  if (task) {
    task.paneId = undefined;
    if (task.status === 'doing') setTaskStatus(project, task, 'review');
  }
  renderSessionBar();
  renderTabs();
  renderTasks();
  renderSessions();
  updateBadge();
  save();
  return true;
}

function cyclePane(step: number) {
  const project = activeProject();
  if (!project?.panes.length) return;
  const i = project.panes.findIndex((p) => p.id === focusedPaneId);
  showPane(project, project.panes[(i + step + project.panes.length) % project.panes.length].id);
}

// --- Dragging sessions -------------------------------------------------------------------------
// A session tab (or a tile's header) can be dropped on the tab bar to reorder, on the middle of a
// tile to take its place, or on a tile's edge to split it.

let dragPaneId: string | null = null;
let sessionBarDirty = false;

function beginDrag(e: DragEvent, paneId: string) {
  dragPaneId = paneId;
  e.dataTransfer?.setData(DRAG_TYPE, paneId);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  // Let the browser take the drag image before the drop overlays cover the tiles.
  requestAnimationFrame(() => document.body.classList.add('dragging-pane'));
}

function endDrag() {
  dragPaneId = null;
  document.body.classList.remove('dragging-pane');
  for (const el of document.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  for (const v of views.values()) delete v.dropEl.dataset.zone;
  if (sessionBarDirty) {
    sessionBarDirty = false;
    renderSessionBar();
  }
}

function zoneAt(el: HTMLElement, e: DragEvent): DropZone {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const edges: Array<[Side, number]> = [
    ['left', x],
    ['right', 1 - x],
    ['top', y],
    ['bottom', 1 - y],
  ];
  const [side, distance] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return distance < 0.25 ? side : 'center';
}

function dropOnPane(project: ProjectState, targetId: string, draggedId: string, zone: DropZone) {
  if (draggedId === targetId || !project.panes.some((p) => p.id === draggedId)) return;
  const layout = removePane(project.layout, draggedId);
  if (!layout) return;
  project.layout = zone === 'center' ? replacePane(layout, targetId, draggedId) : splitPane(layout, targetId, draggedId, zone);
  renderLayout(project);
  focusPane(draggedId);
  save();
}

function dropOnTab(project: ProjectState, targetId: string, draggedId: string, after: boolean) {
  if (draggedId === targetId) return;
  const from = project.panes.findIndex((p) => p.id === draggedId);
  if (from < 0) return;
  const [moved] = project.panes.splice(from, 1);
  const to = project.panes.findIndex((p) => p.id === targetId) + (after ? 1 : 0);
  project.panes.splice(to, 0, moved);
  renderSessionBar();
  save();
}

// --- Session tab bar ---------------------------------------------------------------------------

const sessionTabEls = new Map<string, HTMLElement>();

function renderSessionBar() {
  // Replacing the tab being dragged or renamed would cancel that; rebuild once it ends.
  if (dragPaneId || sessionBarEl.querySelector('[contenteditable="true"]')) {
    sessionBarDirty = true;
    return;
  }
  sessionTabEls.clear();
  const project = activeProject();
  if (!project) {
    sessionBarEl.replaceChildren();
    return;
  }
  const tabs = project.panes.map((pane) => {
    const v = views.get(pane.id)!;
    const tab = h('div', 'stab');
    tab.draggable = true;
    const close = iconEl(ICONS.close, 'stab-close');
    close.title = 'Close session (⌘W)';
    const title = h('span', 'stab-title');
    tab.append(iconEl(pane.kind === 'claude' ? ICONS.claude : ICONS.shell, `stab-icon ${pane.kind}`), title, h('span', 'dot'), close);
    tab.addEventListener('click', (e) => {
      if (close.contains(e.target as Node)) closePane(v);
      else if (!title.isContentEditable) showPane(project, pane.id);
    });
    tab.addEventListener('auxclick', (e) => e.button === 1 && closePane(v));
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void sessionMenu(v, 'tab');
    });
    tab.addEventListener('dragstart', (e) => beginDrag(e, pane.id));
    tab.addEventListener('dragend', endDrag);
    const dropsAfter = (e: DragEvent) => {
      const r = tab.getBoundingClientRect();
      return e.clientX > r.left + r.width / 2;
    };
    tab.addEventListener('dragover', (e) => {
      if (!dragPaneId) return;
      e.preventDefault();
      const after = dropsAfter(e);
      tab.classList.toggle('drop-after', after);
      tab.classList.toggle('drop-before', !after);
    });
    // Moving onto the tab's own title or icons also fires a dragleave; only leaving the tab counts.
    tab.addEventListener('dragleave', (e) => {
      if (!tab.contains(e.relatedTarget as Node | null)) tab.classList.remove('drop-before', 'drop-after');
    });
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      const dragged = dragPaneId;
      const after = dropsAfter(e);
      endDrag();
      if (dragged) dropOnTab(project, pane.id, dragged, after);
    });
    sessionTabEls.set(pane.id, tab);
    return tab;
  });
  const add = iconEl(ICONS.plus, 'stab-add');
  add.title = 'New Claude session (⌘T) · split with ⌘D';
  add.addEventListener('click', () => addPane('claude', project));
  sessionBarEl.replaceChildren(...tabs, add);
  paintSessionTabs();
}

function paintSessionTab(v: PaneView) {
  const tab = sessionTabEls.get(v.pane.id);
  if (!tab) return;
  tab.classList.toggle('active', v.pane.id === focusedPaneId);
  tab.classList.toggle('visible', isVisible(v));
  tab.classList.toggle('unread', isUnread(v));
  const title = tab.querySelector<HTMLElement>('.stab-title')!;
  if (!title.isContentEditable) title.textContent = displayTitle(v);
  tab.querySelector('.dot')!.className = `dot ${dotClass(v)}`;
  tab.title = `${displayTitle(v)}${v.pane.branch ? `\n⎇ ${v.pane.branch}` : ''}\nDrag onto a terminal to split, right-click for more`;
}

function paintSessionTabs() {
  for (const id of sessionTabEls.keys()) {
    const v = views.get(id);
    if (v) paintSessionTab(v);
  }
}

// --- Projects ----------------------------------------------------------------------------------

function projectStatus(project: ProjectState): string {
  const list = project.panes.flatMap((p) => views.get(p.id) ?? []);
  if (list.some((v) => v.status === 'attention')) return 'attention';
  if (list.some((v) => v.status === 'running')) return 'running';
  if (list.some(isUnread)) return 'unread';
  return '';
}

function projectIcon(project: ProjectState): HTMLElement {
  if (project.icon?.image) {
    const img = h('img', 'tab-img');
    img.src = project.icon.image;
    img.alt = '';
    // An image drags on its own; the tab around it is what gets dragged.
    img.draggable = false;
    return img;
  }
  const glyph = iconEl(KIND_GLYPH[project.icon?.kind ?? 'folder'], 'tab-glyph');
  // Keyed on the folder, so renaming the project keeps its colour.
  glyph.style.setProperty('--hue', String(hue(folderName(project.path))));
  return glyph;
}

// Project tabs are dragged to reorder them, the same way session tabs are.
const PROJECT_DRAG_TYPE = 'application/x-liszt-project';
const projectTabEls = new Map<string, HTMLElement>();
let dragProjectId: string | null = null;
let tabsDirty = false;

function renderTabs() {
  // Replacing the tab being dragged or renamed would cancel that; rebuild once it ends.
  if (dragProjectId || tabsEl.querySelector('[contenteditable="true"]')) {
    tabsDirty = true;
    return;
  }
  tabsDirty = false;
  projectTabEls.clear();
  tabsEl.replaceChildren(
    ...state.projects.map((p) => {
      const tab = h('div', `tab${p.id === state.activeProjectId ? ' active' : ''}${p.folded ? ' folded' : ''}`);
      tab.draggable = true;
      tab.title = `${p.name}\n${p.path}\nDrag to reorder, right-click to rename, fold or change the icon`;
      const close = iconEl(ICONS.close, 'tab-close');
      close.title = 'Close project (⇧⌘W)';
      const name = h('span', 'tab-name', p.name);
      tab.append(projectIcon(p), name);
      if (p.panes.length > 1) tab.append(h('span', 'tab-count', String(p.panes.length)));
      tab.append(h('span', `dot ${projectStatus(p)}`), close);
      tab.addEventListener('click', (e) => {
        if (close.contains(e.target as Node)) closeProject(p);
        else if (!name.isContentEditable) activateProject(p.id);
      });
      tab.addEventListener('auxclick', (e) => e.button === 1 && closeProject(p));
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        void projectMenu(p);
      });
      tab.addEventListener('dragstart', (e) => {
        dragProjectId = p.id;
        e.dataTransfer?.setData(PROJECT_DRAG_TYPE, p.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        tab.classList.add('dragging');
      });
      tab.addEventListener('dragend', endProjectDrag);
      const dropsAfter = (e: DragEvent) => {
        const r = tab.getBoundingClientRect();
        return e.clientX > r.left + r.width / 2;
      };
      tab.addEventListener('dragover', (e) => {
        if (!dragProjectId) return;
        e.preventDefault();
        const after = dropsAfter(e);
        tab.classList.toggle('drop-after', after);
        tab.classList.toggle('drop-before', !after);
      });
      tab.addEventListener('dragleave', (e) => {
        if (!tab.contains(e.relatedTarget as Node | null)) tab.classList.remove('drop-before', 'drop-after');
      });
      tab.addEventListener('drop', (e) => {
        if (!dragProjectId) return;
        e.preventDefault();
        const dragged = dragProjectId;
        const after = dropsAfter(e);
        endProjectDrag();
        dropOnProject(p.id, dragged, after);
      });
      projectTabEls.set(p.id, tab);
      return tab;
    }),
  );
}

function endProjectDrag() {
  dragProjectId = null;
  for (const el of tabsEl.querySelectorAll('.drop-before, .drop-after, .dragging')) el.classList.remove('drop-before', 'drop-after', 'dragging');
  if (tabsDirty) renderTabs();
}

function dropOnProject(targetId: string, draggedId: string, after: boolean) {
  if (draggedId === targetId) return;
  const from = state.projects.findIndex((p) => p.id === draggedId);
  if (from < 0) return;
  const [moved] = state.projects.splice(from, 1);
  const to = state.projects.findIndex((p) => p.id === targetId) + (after ? 1 : 0);
  state.projects.splice(to, 0, moved);
  renderTabs();
  save();
}

function setProjectName(project: ProjectState, name: string) {
  project.name = name;
  renderTabs();
  renderSessions();
  // The Tasks and Changes headers and an empty stage's placeholder show the name too.
  if (project.id === state.activeProjectId) {
    renderTasks();
    void refreshGit();
  }
  if (!project.layout) renderLayout(project);
  save();
}

/** Renames a project on its tab; an empty name goes back to the folder name. */
function renameProject(project: ProjectState) {
  const name = projectTabEls.get(project.id)?.querySelector<HTMLElement>('.tab-name');
  if (!name) return;
  editText(name, project.name, (text) => {
    if (text === null) renderTabs();
    else setProjectName(project, text || folderName(project.path));
  });
}

function foldProjects(projects: ProjectState[], folded: boolean) {
  for (const p of projects) p.folded = folded;
  renderTabs();
  save();
}

async function detectIcon(project: ProjectState) {
  project.icon = await api.projectIcon(project.path);
  renderTabs();
  save();
}

async function projectMenu(project: ProjectState) {
  const others = state.projects.filter((p) => p !== project);
  const choice = await api.projectMenu({
    renamed: project.name !== folderName(project.path),
    folded: Boolean(project.folded),
    othersUnfolded: others.some((p) => !p.folded),
    anyFolded: state.projects.some((p) => p.folded),
  });
  // The project may have been closed while the menu was open.
  if (!state.projects.includes(project)) return;
  switch (choice) {
    case 'rename':
      return renameProject(project);
    case 'reset-name':
      return setProjectName(project, folderName(project.path));
    case 'fold':
      return foldProjects([project], !project.folded);
    case 'fold-others':
      return foldProjects(others, true);
    case 'unfold-all':
      return foldProjects(state.projects, false);
    case 'icon-choose': {
      const image = await api.pickIcon();
      if (!image) return;
      project.icon = { kind: project.icon?.kind ?? 'folder', image, custom: true };
      renderTabs();
      save();
      return;
    }
    case 'icon-detect':
      return void detectIcon(project);
    case 'reveal':
      return api.reveal(project.path);
    case 'close':
      return closeProject(project);
  }
}

function activateProject(id: string | null) {
  state.activeProjectId = id;
  for (const [pid, stage] of stages) stage.classList.toggle('active', pid === id);
  emptyEl.hidden = state.projects.length > 0;
  const project = activeProject();
  if (project) {
    // Sessions start the first time their project is opened, so a long project list stays cheap.
    for (const pane of project.panes) {
      const v = views.get(pane.id)!;
      if (!v.spawned) void spawn(v, pane.kind === 'claude' && pane.started);
    }
    for (const paneId of panesIn(project.layout)) scheduleFit(views.get(paneId)!);
    // Older states can still point at a pane that was closed.
    const last = project.activePaneId ? views.get(project.activePaneId) : undefined;
    focusPane(last && isVisible(last) ? last.pane.id : panesIn(project.layout)[0]);
  }
  renderTabs();
  renderSessionBar();
  renderTasks();
  void refreshGit();
  save();
}

function cycleProject(step: number) {
  const n = state.projects.length;
  if (!n) return;
  const i = state.projects.findIndex((p) => p.id === state.activeProjectId);
  activateProject(state.projects[(i + step + n) % n].id);
}

const folderName = (dir: string) => dir.split('/').filter(Boolean).pop() ?? dir;

function createProject(dir: string): ProjectState {
  const project: ProjectState = {
    id: uuid(),
    name: folderName(dir),
    path: dir,
    panes: [],
    layout: null,
    tasks: [],
    autopilot: { on: false, limit: 2 },
  };
  state.projects.push(project);
  renderLayout(project);
  void detectIcon(project);
  return project;
}

async function addProject() {
  const dir = await api.pickFolder();
  if (!dir) return;
  const existing = state.projects.find((p) => p.path === dir);
  if (existing) return activateProject(existing.id);
  const project = createProject(dir);
  activateProject(project.id);
  addPane('claude', project);
}

function closeProject(project: ProjectState) {
  const busy = project.panes.some((p) => ['running', 'attention'].includes(views.get(p.id)?.status ?? ''));
  if (busy && !confirm(`${project.name} has sessions still working. Close the project?`)) return;
  for (const pane of project.panes) {
    const v = views.get(pane.id);
    if (!v) continue;
    api.kill(pane.id);
    if (pane.kind === 'claude') api.stopBackground(pane.sessionId, pane.bgId);
    v.term.dispose();
    v.el.remove();
    views.delete(pane.id);
  }
  stages.get(project.id)?.remove();
  stages.delete(project.id);
  const i = state.projects.indexOf(project);
  state.projects.splice(i, 1);
  if (state.activeProjectId === project.id) activateProject(state.projects[Math.min(i, state.projects.length - 1)]?.id ?? null);
  else renderTabs();
  renderSessions();
  updateBadge();
  save();
}

// --- Tasks and Autopilot -----------------------------------------------------------------------
// A task card runs in its own git worktree with its own Claude session. Autopilot starts Todo cards
// on its own whenever fewer than `limit` cards are in progress; a card moves to Review when Claude
// ends its turn, which frees the slot for the next one.

const SECTIONS: Array<[TaskStatus, string]> = [
  ['todo', 'Todo'],
  ['doing', 'In progress'],
  ['review', 'Review'],
  ['done', 'Done'],
];
const startingTasks = new Set<string>();
const pumping = new Set<string>();
const expandedTasks = new Set<string>();
const taskChips = new Map<string, HTMLElement>();
let showDone = false;

function setTaskStatus(project: ProjectState, task: TaskState, status: TaskStatus) {
  if (task.status === status) return;
  task.status = status;
  renderTasks();
  save();
  // Leaving "doing" frees an Autopilot slot.
  if (status !== 'doing') void pump(project);
}

function addTask(title: string) {
  const project = activeProject();
  if (!project) return;
  project.tasks.push({ id: uuid(), title, status: 'todo', createdAt: Date.now() });
  renderTasks();
  save();
  void pump(project);
}

async function startTask(project: ProjectState, task: TaskState, byHand: boolean) {
  if (startingTasks.has(task.id) || task.status !== 'todo') return;
  startingTasks.add(task.id);
  task.status = 'doing';
  task.error = undefined;
  renderTasks();
  save();
  const res = await api.addWorktree(project.path, task.title);
  startingTasks.delete(task.id);
  if (!state.projects.includes(project) || !project.tasks.includes(task)) return;
  if (!res.ok) {
    task.status = 'todo';
    task.error = res.error;
    renderTasks();
    save();
    return;
  }
  task.worktree = res.dir;
  task.cwd = res.cwd;
  task.branch = res.branch;
  const prompt = task.body?.trim() ? `${task.title}\n\n${task.body.trim()}` : task.title;
  // Autopilot's sessions open as background tabs so they never pull the view away from you.
  const v = addPane('claude', project, {
    cwd: res.cwd,
    taskId: task.id,
    branch: res.branch,
    title: task.title,
    prompt,
    show: byHand,
    focus: byHand,
  });
  task.paneId = v?.pane.id;
  renderTasks();
  save();
}

/** Starts Todo cards while Autopilot is on and has free slots. */
async function pump(project: ProjectState) {
  if (!project.autopilot.on || pumping.has(project.id)) return;
  pumping.add(project.id);
  try {
    for (;;) {
      if (!project.autopilot.on || !state.projects.includes(project)) break;
      const inProgress = project.tasks.filter((t) => t.status === 'doing').length;
      // A card whose start failed waits for a manual retry instead of failing in a loop.
      const next = project.tasks.find((t) => t.status === 'todo' && !t.error);
      if (!next || inProgress >= project.autopilot.limit) break;
      await startTask(project, next, false);
    }
  } finally {
    pumping.delete(project.id);
  }
}

function openTask(project: ProjectState, task: TaskState) {
  const existing = task.paneId ? views.get(task.paneId) : undefined;
  if (existing) return revealPane(existing);
  if (!task.cwd) return;
  const v = addPane('claude', project, { cwd: task.cwd, taskId: task.id, branch: task.branch, title: task.title, sessionId: task.sessionId });
  task.paneId = v?.pane.id;
  renderTasks();
  save();
}

function finishTask(project: ProjectState, task: TaskState) {
  const v = task.paneId ? views.get(task.paneId) : undefined;
  if (v && !closePane(v)) return;
  task.paneId = undefined;
  setTaskStatus(project, task, 'done');
}

async function removeTaskWorktree(project: ProjectState, task: TaskState) {
  if (!task.worktree) return;
  if (!confirm(`Remove the worktree of "${task.title}"?\n\n${task.worktree}\n\nThe branch ${task.branch} is kept.`)) return;
  const v = task.paneId ? views.get(task.paneId) : undefined;
  if (v && !closePane(v)) return;
  const res = await api.removeWorktree(project.path, task.worktree);
  if (!res.ok) {
    alert(`Git did not remove the worktree:\n\n${res.error}`);
    return;
  }
  task.worktree = undefined;
  task.cwd = undefined;
  renderTasks();
  save();
}

function deleteTask(project: ProjectState, task: TaskState) {
  if (task.worktree && !confirm(`Delete "${task.title}"? Its worktree stays on disk:\n\n${task.worktree}`)) return;
  project.tasks = project.tasks.filter((t) => t !== task);
  expandedTasks.delete(task.id);
  renderTasks();
  save();
}

function renderTaskChips() {
  for (const [taskId, el] of taskChips) {
    const task = activeProject()?.tasks.find((t) => t.id === taskId);
    const v = task?.paneId ? views.get(task.paneId) : undefined;
    if (v) paintChip(el, v);
  }
}

function renderCard(project: ProjectState, task: TaskState): HTMLElement {
  const card = h('div', `task ${task.status}`);
  const open = expandedTasks.has(task.id);
  const starting = startingTasks.has(task.id);

  const title = h('div', 'task-title', task.title);
  title.title = 'Click for details';
  title.addEventListener('click', () => {
    if (open) expandedTasks.delete(task.id);
    else expandedTasks.add(task.id);
    renderTasks();
  });
  card.append(title);

  const meta = h('div', 'task-meta');
  if (starting) meta.append(h('span', 'muted', 'Creating worktree…'));
  else if (task.branch) meta.append(h('span', 'task-branch', `⎇ ${task.branch}`));
  const v = task.paneId ? views.get(task.paneId) : undefined;
  if (v && !starting) {
    const chip = h('span');
    taskChips.set(task.id, chip);
    paintChip(chip, v);
    meta.append(chip);
  }
  if (meta.childNodes.length) card.append(meta);
  if (task.error) card.append(h('div', 'task-error', task.error));

  if (open) {
    if (task.status === 'todo') {
      const notes = h('textarea', 'task-notes');
      notes.placeholder = 'Details for Claude (optional)';
      notes.value = task.body ?? '';
      notes.rows = 3;
      notes.dataset.taskId = task.id;
      notes.addEventListener('input', () => {
        task.body = notes.value;
        save();
      });
      card.append(notes);
    } else if (task.body) {
      card.append(h('div', 'task-body', task.body));
    }
    if (task.cwd) card.append(h('div', 'task-path', task.cwd));
  }

  const actions = h('div', 'task-actions');
  const button = (label: string, onClick: () => void, cls?: string) => {
    const b = h('button', cls, label);
    b.addEventListener('click', onClick);
    actions.append(b);
  };
  switch (task.status) {
    case 'todo':
      button(task.error ? 'Retry' : 'Start', () => void startTask(project, task, true), 'go');
      if (open) button('Delete', () => deleteTask(project, task));
      break;
    case 'doing':
      if (!starting) button('Open', () => openTask(project, task));
      break;
    case 'review':
      if (task.cwd) button('Open', () => openTask(project, task));
      button('Done', () => finishTask(project, task), 'go');
      break;
    case 'done':
      button('Reopen', () => setTaskStatus(project, task, 'review'));
      if (task.worktree) button('Remove worktree', () => void removeTaskWorktree(project, task));
      button('Delete', () => deleteTask(project, task));
      break;
  }
  if (actions.childNodes.length) card.append(actions);
  return card;
}

function renderTasks() {
  const project = activeProject();
  tasksProjectEl.textContent = project?.name ?? '';
  taskInput.disabled = !project;
  taskChips.clear();
  if (!project) {
    taskListEl.replaceChildren();
    return;
  }
  apOffBtn.classList.toggle('on', !project.autopilot.on);
  apOnBtn.classList.toggle('on', project.autopilot.on);
  apLimit.value = String(project.autopilot.limit);

  // Rebuilding must not take the caret away from a card's notes field.
  const active = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
  const keep = active?.dataset.taskId ? { id: active.dataset.taskId, start: active.selectionStart, end: active.selectionEnd } : null;

  const sections: HTMLElement[] = [];
  for (const [status, label] of SECTIONS) {
    const tasks = project.tasks.filter((t) => t.status === status);
    if (!tasks.length && status !== 'todo') continue;
    const section = h('div', 'task-section');
    if (status === 'done') {
      const head = h('button', 'task-section-head', `${showDone ? '▾' : '▸'} ${label} · ${tasks.length}`);
      head.addEventListener('click', () => {
        showDone = !showDone;
        renderTasks();
      });
      section.append(head);
      if (showDone) for (const t of tasks) section.append(renderCard(project, t));
    } else {
      section.append(h('div', 'task-section-head', `${label} · ${tasks.length}`));
      for (const t of tasks) section.append(renderCard(project, t));
      if (status === 'todo' && !tasks.length) section.append(h('div', 'side-note', 'Nothing waiting.'));
    }
    sections.push(section);
  }
  taskListEl.replaceChildren(...sections);

  if (keep) {
    const notes = taskListEl.querySelector<HTMLTextAreaElement>(`textarea[data-task-id="${keep.id}"]`);
    notes?.focus();
    notes?.setSelectionRange(keep.start, keep.end);
  }
}

function setAutopilot(on: boolean) {
  const project = activeProject();
  if (!project) return;
  project.autopilot.on = on;
  renderTasks();
  save();
  void pump(project);
}

// --- Sessions panel ----------------------------------------------------------------------------
// Every Claude Code session on the machine in one list: the panes in Liszt, the ones running
// elsewhere (other terminals, the desktop app, background sessions) and the ones nothing runs,
// which are finished background sessions and every session the Claude desktop app keeps, archived
// and pinned ones included. A row shows its pane, or opens the session in a new pane of its
// folder's project: background sessions with `claude attach`, the rest with `claude --resume`.
// A row's menu closes, archives or deletes its session. Archiving is Liszt's own: it never writes
// to the Claude app's files, and it keeps the title and folder of a session listed nowhere else.

const STATUS_ORDER: Record<Status, number> = { attention: 0, running: 1, starting: 2, idle: 3, exited: 4 };
/** Replies waiting to be read sort right after the running sessions. */
const UNREAD_RANK = 1.5;
/** Sessions nothing runs sort after every running one. */
const NOT_RUNNING = 5;
const sessionChips = new Map<string, HTMLElement>();
/** Sessions being closed or deleted, with what the row says meanwhile. */
const pendingSessions = new Map<string, string>();

let agents: AgentSession[] = [];
let appSessions: AppSession[] = [];

type SessionGroup = 'liszt' | 'elsewhere' | 'stopped';

const GROUPS: Array<[SessionGroup, string]> = [
  ['liszt', 'In Liszt'],
  ['elsewhere', 'Running elsewhere'],
  ['stopped', 'Not running'],
];

interface SessionRow {
  group: SessionGroup;
  sessionId: string;
  /** Short id of a background session, which Claude Code stops and deletes. */
  bgId?: string;
  cwd: string;
  title: string;
  /** Liszt project or folder name; Sort → Project groups by it. */
  project: string;
  where: string;
  detail: string;
  /** Lower comes first when sorting by status. */
  rank: number;
  /** Last activity, for Sort → Recent. */
  time: number;
  pinned: boolean;
  archived: boolean;
  /** A process runs it, in Liszt or elsewhere. */
  live: boolean;
  dot: string;
  chip: [cls: string, text: string];
  tooltip: string;
  /** Missing when the session cannot be opened. */
  open?: () => void;
  view?: PaneView;
}

const FILTERS: Record<SessionFilter, (r: SessionRow) => boolean> = {
  active: (r) => !r.archived || r.group !== 'stopped',
  liszt: (r) => r.group === 'liszt',
  running: (r) => r.live,
  pinned: (r) => r.pinned,
  archived: (r) => r.archived,
  all: () => true,
};

const SORTS: Record<SessionSort, (a: SessionRow, b: SessionRow) => number> = {
  status: (a, b) => a.rank - b.rank || b.time - a.time,
  recent: (a, b) => b.time - a.time,
  name: (a, b) => a.title.localeCompare(b.title),
  // Rows are grouped by project first; inside a project the ones that need you come first.
  project: (a, b) => a.rank - b.rank || b.time - a.time,
};

const samePath = (a: string, b: string) => a.replace(/(.)\/+$/, '$1') === b.replace(/(.)\/+$/, '$1');
const projectFor = (dir: string) => state.projects.find((p) => samePath(p.path, dir));
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Lowercase without accents, so "gecis" finds "Geçiş" and "istanbul" finds "İstanbul". */
const fold = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');

/** Liszt's archive choice wins over the Claude app's. */
const isArchived = (sessionId: string, inApp = false) => state.sessionMarks[sessionId]?.archived ?? inApp;
/** Deleted from Liszt and run by nothing, so its row stays hidden. */
const isDeleted = (sessionId: string) => Boolean(state.sessionMarks[sessionId]?.deleted);

function sessionRows(): SessionRow[] {
  const app = new Map(appSessions.map((s) => [s.sessionId, s]));
  const ours = new Set<string>();
  const listed = new Set<string>();
  const rows: SessionRow[] = [];
  for (const v of views.values()) {
    if (v.pane.kind !== 'claude') continue;
    ours.add(v.pane.sessionId);
    listed.add(v.pane.sessionId);
    if (v.pane.bgId) ours.add(v.pane.bgId);
    const s = app.get(v.pane.sessionId);
    const pinnedAgent = agents.some((a) => a.pinned && a.id && a.id === v.pane.bgId);
    rows.push({
      group: 'liszt',
      sessionId: v.pane.sessionId,
      bgId: v.pane.bgId,
      cwd: v.pane.cwd ?? v.project.path,
      title: displayTitle(v),
      project: v.project.name,
      where: v.pane.branch ? `${v.project.name} · ⎇ ${v.pane.branch}` : v.project.name,
      detail: v.activity || 'Waiting for a prompt',
      rank: isUnread(v) ? UNREAD_RANK : STATUS_ORDER[v.status],
      time: v.since,
      pinned: Boolean(s?.pinned) || pinnedAgent,
      archived: isArchived(v.pane.sessionId, s?.archived),
      live: v.status !== 'exited',
      dot: dotClass(v),
      chip: [chipClass(v), chipText(v)],
      tooltip: 'Show this session',
      open: () => revealPane(v),
      view: v,
    });
  }
  for (const a of agents) {
    listed.add(a.sessionId);
    if (ours.has(a.sessionId) || (a.id && ours.has(a.id))) continue;
    const s = app.get(a.sessionId);
    app.delete(a.sessionId);
    if (a.ended && isDeleted(a.sessionId)) continue;
    const busy = a.status === 'busy' && !a.ended;
    const folder = folderName(a.cwd);
    const named = a.name && a.name !== a.id ? a.name : '';
    const bgId = a.kind === 'background' ? a.id : undefined;
    rows.push({
      group: a.ended ? 'stopped' : 'elsewhere',
      sessionId: a.sessionId,
      bgId,
      cwd: a.cwd,
      title: named || s?.title || folder,
      project: projectFor(a.cwd)?.name ?? folder,
      where: `${folder} · started ${duration(Date.now() - a.startedAt)} ago`,
      detail: bgId ? ['Background', bgId, a.state].filter(Boolean).join(' · ') : s ? 'Claude app' : 'Interactive',
      rank: a.ended ? NOT_RUNNING : busy ? STATUS_ORDER.running : STATUS_ORDER.idle,
      time: Math.max(a.startedAt, s?.lastActivityAt ?? 0),
      pinned: Boolean(a.pinned || s?.pinned),
      archived: isArchived(a.sessionId, s?.archived),
      live: !a.ended,
      dot: busy ? 'running' : '',
      // Ended background sessions are done, stopped or failed; they stay openable, so they stay listed.
      chip: a.ended
        ? [`chip ${a.state === 'failed' ? 'exited' : ''}`, capitalize(a.state ?? 'ended')]
        : [`chip ${busy ? 'running' : 'idle'}`, busy ? 'Busy' : 'Idle'],
      tooltip: `${a.cwd}\nClick to open in Liszt (${bgId ? `claude attach ${bgId}` : 'claude --resume'})`,
      open: () => openSession(a.cwd, a.sessionId, named, bgId),
    });
  }
  for (const s of app.values()) {
    listed.add(s.sessionId);
    if (ours.has(s.sessionId) || isDeleted(s.sessionId)) continue;
    const folder = folderName(s.cwd);
    const gone = s.gone === 'folder' ? 'its folder no longer exists' : s.gone === 'transcript' ? 'Claude Code deleted the conversation' : '';
    const archived = isArchived(s.sessionId, s.archived);
    rows.push({
      group: 'stopped',
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      project: projectFor(s.cwd)?.name ?? folder,
      where: `${folder} · active ${duration(Date.now() - s.lastActivityAt)} ago`,
      detail: gone ? `Claude app · ${gone}` : 'Claude app',
      rank: NOT_RUNNING,
      time: s.lastActivityAt,
      pinned: s.pinned,
      archived,
      live: false,
      dot: '',
      chip: ['chip', archived ? 'Archived' : ''],
      tooltip: gone ? `${s.cwd}\nCannot be opened: ${gone}` : `${s.cwd}\nClick to open in Liszt (claude --resume)`,
      open: gone ? undefined : () => openSession(s.cwd, s.sessionId, s.title),
    });
  }
  // Sessions archived from Liszt that nothing else lists any more: closed panes and interactive sessions.
  for (const [sessionId, m] of Object.entries(state.sessionMarks)) {
    if (!m.cwd || m.deleted || listed.has(sessionId)) continue;
    const cwd = m.cwd;
    const folder = folderName(cwd);
    const title = m.title || folder;
    rows.push({
      group: 'stopped',
      sessionId,
      cwd,
      title,
      project: projectFor(cwd)?.name ?? folder,
      where: `${folder} · closed ${duration(Date.now() - m.at)} ago`,
      detail: 'Kept by Liszt',
      rank: NOT_RUNNING,
      time: m.at,
      pinned: false,
      archived: Boolean(m.archived),
      live: false,
      dot: '',
      chip: ['chip', m.archived ? 'Archived' : ''],
      tooltip: `${cwd}\nClick to open in Liszt (claude --resume)`,
      open: () => openSession(cwd, sessionId, title),
    });
  }
  return rows;
}

function renderSessionRow(r: SessionRow): HTMLElement {
  const row = h('div', 'srow');
  if (r.view) row.classList.add(r.view.status);
  else row.classList.add('outside', ...(r.dot === 'running' ? ['running'] : []), ...(r.group === 'stopped' ? ['ended'] : []));
  if (!r.open) row.classList.add('gone');
  const pending = pendingSessions.get(r.sessionId);
  if (pending) row.classList.add('pending');
  const chip = h('span', r.chip[0], r.chip[1]);
  if (r.view) sessionChips.set(r.view.pane.id, chip);
  const more = iconEl(ICONS.more, 'srow-more');
  more.title = 'Close, archive or delete';
  const top = h('div', 'srow-top');
  top.append(h('span', `dot ${r.dot}`));
  if (r.pinned) top.append(iconEl(ICONS.pin, 'srow-pin'));
  top.append(h('span', 'srow-title', r.title), chip, more);
  row.append(top, h('div', 'srow-where', r.where), h('div', 'srow-activity', pending ?? r.detail));
  row.title = r.tooltip;
  row.addEventListener('click', (e) => {
    if (more.contains(e.target as Node)) void sessionRowMenu(r);
    else r.open?.();
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void sessionRowMenu(r);
  });
  return row;
}

async function sessionRowMenu(r: SessionRow) {
  if (pendingSessions.has(r.sessionId)) return;
  const choice = await api.sessionRowMenu({
    inLiszt: Boolean(r.view),
    canOpen: Boolean(r.open),
    canClose: Boolean(r.view) || r.live,
    archived: r.archived,
  });
  // Its pane may have been closed while the menu was open.
  if (r.view && views.get(r.view.pane.id) !== r.view) return;
  switch (choice) {
    case 'open':
      return r.open?.();
    case 'close':
      return void closeSession(r);
    case 'archive':
      return void archiveSession(r, true);
    case 'unarchive':
      return void archiveSession(r, false);
    case 'delete':
      return void deleteSession(r);
  }
}

/** Runs a close or delete in main while the row says so; false when it failed, after saying why. */
async function sessionAction(r: SessionRow, label: string, act: Promise<GitResult>): Promise<boolean> {
  pendingSessions.set(r.sessionId, label);
  renderSessions();
  const res = await act;
  pendingSessions.delete(r.sessionId);
  renderSessions();
  if (!res.ok) alert(`${label.replace('…', '')} "${r.title}" failed:\n\n${res.error}`);
  return res.ok;
}

/**
 * Ends whatever runs a session: its Liszt pane, `claude stop` for a background session, or the
 * process of an interactive one elsewhere. The conversation is kept. False when it keeps running.
 */
async function closeSession(r: SessionRow): Promise<boolean> {
  if (r.view) return closePane(r.view);
  if (!r.live) return true;
  const busy = r.dot === 'running';
  // Ending a process in another terminal or the Claude app is less expected than stopping an idle background session.
  if ((busy || !r.bgId) && !confirm(`Close "${r.title}"?\n\nIt runs outside Liszt${busy ? ' and is still working' : ''}. Its conversation is kept and can be resumed.`)) return false;
  if (!(await sessionAction(r, 'Closing…', api.closeSession(r.sessionId, r.bgId)))) return false;
  // Until the next poll: an interactive session is no longer listed, a background one is stopped.
  agents = agents.flatMap((a) => (a.sessionId !== r.sessionId ? [a] : a.kind === 'background' ? [{ ...a, ended: true, state: 'stopped' }] : []));
  renderSessions();
  return true;
}

/** Archiving closes the session first; its title and folder are kept, as nothing may list it once it is closed. */
async function archiveSession(r: SessionRow, archived: boolean) {
  if (archived && (r.view || r.live) && !(await closeSession(r))) return;
  const mark = state.sessionMarks[r.sessionId];
  state.sessionMarks[r.sessionId] = archived
    ? { archived, title: r.title, cwd: r.cwd, at: Date.now() }
    : { ...mark, archived, at: mark?.at ?? Date.now() };
  renderSessions();
  save();
}

async function deleteSession(r: SessionRow) {
  const how = `${
    r.bgId ? `Claude Code removes the background session ${r.bgId} (claude rm), and its worktree when nothing would be lost. ` : ''
  }Its conversation is moved to the Trash and can no longer be resumed.`;
  const running = r.view || r.live ? '\n\nIt is closed first.' : '';
  // Liszt does not write to the app's files, so the app keeps its own entry.
  const inApp = appSessions.some((s) => s.sessionId === r.sessionId) ? '\n\nThe Claude app keeps listing it until you delete it there.' : '';
  if (!confirm(`Delete "${r.title}"?\n\n${how}${running}${inApp}`)) return;
  // Claude Code deletes a background session itself; stopping it as well would race with that.
  if (r.view) closePane(r.view, { ask: false, stop: false });
  if (!(await sessionAction(r, 'Deleting…', api.deleteSession(r.sessionId, r.bgId)))) return;
  state.sessionMarks[r.sessionId] = { deleted: true, at: Date.now() };
  agents = agents.filter((a) => a.sessionId !== r.sessionId);
  // A task would otherwise resume the deleted conversation; it starts a new one in its worktree instead.
  for (const project of state.projects) for (const task of project.tasks) if (task.sessionId === r.sessionId) task.sessionId = undefined;
  renderSessions();
  save();
}

function renderSessions() {
  sessionChips.clear();
  if (state.sidebar !== 'sessions') return;
  const all = sessionRows();
  const terms = fold(sessionSearch.value).split(/\s+/).filter(Boolean);
  const shown = all.filter(
    (r) => FILTERS[state.sessionFilter](r) && terms.every((t) => fold(`${r.title} ${r.project} ${r.where} ${r.detail} ${r.tooltip}`).includes(t)),
  );
  const working = all.filter((r) => r.live && r.rank <= STATUS_ORDER.running).length;
  sessionsCountEl.textContent = `${working} working · ${shown.length === all.length ? all.length : `${shown.length} of ${all.length}`}`;

  const byProject = state.sessionSort === 'project';
  const groups = new Map<string, SessionRow[]>();
  for (const r of shown) {
    const key = byProject ? r.project : r.group;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const heads: Array<[string, string]> = byProject
    ? [...groups.keys()].sort((a, b) => a.localeCompare(b)).map((k) => [k, k])
    : GROUPS.filter(([g]) => groups.has(g));
  const sort = SORTS[state.sessionSort];
  const els: HTMLElement[] = [];
  for (const [key, label] of heads) {
    // Pinned sessions lead their group, as in the Claude app's sidebar.
    const list = groups.get(key)!.sort((a, b) => Number(b.pinned) - Number(a.pinned) || sort(a, b));
    const head = h('div', 'sessions-subhead');
    head.append(h('span', undefined, label), h('span', 'muted', String(list.length)));
    els.push(head, ...list.map(renderSessionRow));
  }
  if (!els.length) els.push(h('div', 'side-note', all.length ? 'No sessions match.' : 'No Claude sessions yet.'));
  sessionListEl.replaceChildren(...els);
}

/** Opens a session in a new pane of its folder's project, adding the folder as a project if needed. */
function openSession(cwd: string, sessionId: string, title: string, bgId?: string) {
  const project = projectFor(cwd) ?? createProject(cwd.replace(/(.)\/+$/, '$1'));
  if (state.activeProjectId !== project.id) activateProject(project.id);
  const v = addPane('claude', project, { sessionId, bgId });
  if (v && title) {
    v.pane.title = title;
    renderTitle(v);
    save();
  }
}

function onAppSessions(list: AppSession[]) {
  appSessions = list;
  renderSessions();
}

/** An attached pane gets no hooks unless its session was started by Liszt, so it shows the listed status instead. */
function syncAttached(v: PaneView) {
  if (!v.attached || v.hooked || v.status === 'exited') return;
  const a = agents.find((x) => x.sessionId === v.pane.sessionId);
  if (!a) return;
  const status: Status = a.status === 'busy' ? 'running' : 'idle';
  if (status === v.status) return;
  if (status === 'idle' && v.status === 'running') finishTurn(v);
  else setStatus(v, status);
}

function onAgents(list: AgentSession[]) {
  agents = list;
  for (const v of views.values()) {
    if (v.pane.kind !== 'claude') continue;
    // A pane whose session went to the background (`/background`) follows it there and attaches to
    // it on Resume. Sent before the first prompt, it is a new session with its own id.
    const a = list.find((x) => x.kind === 'background' && x.id && (x.id === v.pane.bgId || x.sessionId === v.pane.sessionId));
    if (a && (v.pane.bgId !== a.id || v.pane.sessionId !== a.sessionId || !v.pane.started)) {
      if (v.pane.sessionId !== a.sessionId) v.pane.transcript = undefined;
      v.pane.bgId = a.id;
      v.pane.sessionId = a.sessionId;
      v.pane.started = true;
      renderActions(v);
      save();
    }
    syncAttached(v);
  }
  renderSessions();
}

// --- Claude hooks ------------------------------------------------------------------------------

function notify(v: PaneView, body: string) {
  if (document.hasFocus() && state.activeProjectId === v.project.id && isVisible(v)) return;
  api.notify({ title: `${v.project.name} · ${displayTitle(v)}`, body, paneId: v.pane.id });
}

function updateBadge() {
  const waiting = [...views.values()].filter((v) => v.status === 'attention').length;
  api.setBadge(waiting ? String(waiting) : '');
}

function onHook(ev: HookEvent) {
  const v = views.get(ev.paneId);
  if (!v) return;
  v.hooked = true;
  // /clear and some resumes switch to a new session id; follow it so a restart resumes the right one.
  if (ev.sessionId) v.pane.sessionId = ev.sessionId;
  if (ev.transcriptPath) v.pane.transcript = ev.transcriptPath;
  switch (ev.event) {
    case 'SessionStart':
      if (ev.source === 'clear') v.pane.started = false;
      if (ev.source === 'resume') v.pane.started = true;
      if (!v.activity || ev.source === 'clear') v.activity = 'Ready';
      setStatus(v, 'idle');
      break;
    case 'UserPromptSubmit':
      v.pane.started = true;
      v.actions = 0;
      if (ev.prompt) {
        const line = ev.prompt.split('\n')[0];
        v.activity = `› ${line}`;
        if (!v.pane.title) {
          v.pane.title = line.slice(0, 60);
          renderTitle(v);
        }
      }
      setStatus(v, 'running');
      break;
    case 'PostToolUse':
      v.actions += 1;
      v.activity = ev.detail ? `${ev.tool} · ${ev.detail}` : (ev.tool ?? 'Tool');
      // The user answered a permission prompt and the tool ran.
      if (v.status === 'attention') setStatus(v, 'running', true);
      else renderSessions();
      break;
    case 'Notification':
      if (v.status === 'running') {
        v.activity = ev.message || 'Waiting for your input';
        setStatus(v, 'attention', true);
        notify(v, v.activity);
      }
      break;
    case 'Stop':
      if (v.status === 'running' || v.status === 'attention') {
        const took = duration(Date.now() - v.since);
        v.activity = `Finished in ${took}${v.actions ? ` · ${v.actions} tool ${v.actions === 1 ? 'call' : 'calls'}` : ''}`;
        finishTurn(v);
        notify(v, `Finished in ${took}`);
      }
      break;
  }

  const task = taskOf(v);
  if (task) {
    if (v.pane.started) task.sessionId = v.pane.sessionId;
    if (ev.event === 'UserPromptSubmit' && task.status === 'review') setTaskStatus(v.project, task, 'doing');
    if (ev.event === 'Stop' && task.status === 'doing') setTaskStatus(v.project, task, 'review');
  }
  save();
}

// --- Git sidebar -------------------------------------------------------------------------------

function codeClass(code: string): string {
  if (code === '??') return 'new';
  if (code.includes('D')) return 'del';
  if (code.includes('R')) return 'ren';
  if (code.includes('A')) return 'add';
  if (code.includes('M')) return 'mod';
  return '';
}

function renderGit(g: GitInfo) {
  if (!g.isRepo) {
    gitEl.replaceChildren(h('div', 'side-note', 'Not a git repository'));
    return;
  }
  const branch = h('div', 'branch');
  branch.append(h('span', 'branch-name', g.branch ?? '(detached)'));
  if (g.upstream) branch.append(h('span', 'muted', g.upstream));
  if (g.ahead) branch.append(h('span', 'muted', `↑${g.ahead}`));
  if (g.behind) branch.append(h('span', 'muted', `↓${g.behind}`));

  const files = g.files ?? [];
  const changes = h('div', 'section');
  changes.append(h('div', 'section-title', `Changes · ${files.length}`));
  for (const f of files.slice(0, 300)) {
    const row = h('div', 'file');
    row.title = f.path;
    row.append(h('span', `code ${codeClass(f.code)}`, f.code.trim() || '?'), h('span', 'path', f.path));
    changes.append(row);
  }
  if (!files.length) changes.append(h('div', 'side-note', 'Working tree clean'));

  const commits = h('div', 'section');
  commits.append(h('div', 'section-title', 'Recent commits'));
  for (const c of g.commits ?? []) {
    const row = h('div', 'commit');
    row.title = `${c.hash} · ${c.when}\n${c.subject}`;
    row.append(h('span', 'subject', c.subject), h('span', 'hash', c.hash));
    commits.append(row);
  }
  gitEl.replaceChildren(branch, changes, commits);
}

let gitSeq = 0;
async function refreshGit() {
  const project = activeProject();
  if (!project) {
    sideProjectEl.textContent = '';
    gitEl.replaceChildren();
    return;
  }
  const focused = focusedPaneId ? views.get(focusedPaneId) : undefined;
  const cwd = focused?.project === project && focused.pane.cwd ? focused.pane.cwd : project.path;
  sideProjectEl.textContent = cwd === project.path ? project.name : `${project.name} · worktree`;
  if (state.sidebar !== 'changes') return;
  const seq = ++gitSeq;
  const info = await api.gitInfo(cwd);
  if (seq === gitSeq) renderGit(info);
}

function setSidebar(view: SidebarView | null) {
  state.sidebar = view;
  document.body.dataset.side = view ?? 'none';
  sidebarBtn.classList.toggle('on', view === 'changes');
  sessionsBtn.classList.toggle('on', view === 'sessions');
  if (view === 'changes') void refreshGit();
  renderSessions();
  save();
}

/** The left panel shows Changes or Sessions, so opening one closes the other. */
function toggleSidebar(view: SidebarView) {
  setSidebar(state.sidebar === view ? null : view);
  if (state.sidebar === 'sessions') sessionSearch.focus();
}

function setTasksPanel(on: boolean) {
  state.tasksPanel = on;
  document.body.classList.toggle('no-tasks', !on);
  tasksBtn.classList.toggle('on', on);
  save();
}

function setFontSize(size: number) {
  state.fontSize = Math.min(24, Math.max(9, size));
  for (const v of views.values()) {
    v.term.options.fontSize = state.fontSize;
    scheduleFit(v);
  }
  save();
}

// --- Wiring ------------------------------------------------------------------------------------

function onMenu(command: string) {
  const focused = focusedPaneId ? views.get(focusedPaneId) : undefined;
  if (command.startsWith('project-')) {
    const project = state.projects[Number(command.slice('project-'.length))];
    if (project) activateProject(project.id);
    return;
  }
  switch (command) {
    case 'new-claude':
      return void addPane('claude');
    case 'new-shell':
      return void addPane('shell');
    case 'split-right':
      return void addPane('claude', activeProject(), { split: 'right' });
    case 'split-down':
      return void addPane('claude', activeProject(), { split: 'bottom' });
    case 'close-pane':
      if (focused) closePane(focused);
      return;
    case 'add-project':
      return void addProject();
    case 'close-project': {
      const project = activeProject();
      if (project) closeProject(project);
      return;
    }
    case 'toggle-sidebar':
      return toggleSidebar('changes');
    case 'toggle-sessions':
      return toggleSidebar('sessions');
    case 'toggle-tasks':
      return setTasksPanel(!state.tasksPanel);
    case 'next-pane':
      return cyclePane(1);
    case 'prev-pane':
      return cyclePane(-1);
    case 'next-project':
      return cycleProject(1);
    case 'prev-project':
      return cycleProject(-1);
    case 'font-up':
      return setFontSize(state.fontSize + 1);
    case 'font-down':
      return setFontSize(state.fontSize - 1);
    case 'font-reset':
      return setFontSize(DEFAULT_FONT_SIZE);
  }
}

api.onData((id, data) => views.get(id)?.term.write(data));
api.onExit((id, code) => {
  const v = views.get(id);
  if (!v) return;
  v.exitCode = code;
  v.activity = code ? `Exited with code ${code}` : 'Exited';
  setStatus(v, 'exited');
  v.term.write(`\r\n\x1b[90m[process exited${code ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
  const task = taskOf(v);
  if (task?.status === 'doing') setTaskStatus(v.project, task, 'review');
});
api.onBackground((id, bgId) => {
  const v = views.get(id);
  if (!v) return;
  v.pane.bgId = bgId;
  save();
  renderSessions();
});
api.onHook(onHook);
api.onAgents(onAgents);
api.onAppSessions(onAppSessions);
api.onMenu(onMenu);
api.onFocusPane((id) => {
  const v = views.get(id);
  if (v) revealPane(v);
});

for (const [id, svg] of [
  ['new-claude', ICONS.claude],
  ['new-shell', ICONS.shell],
  ['toggle-sidebar', ICONS.branch],
  ['toggle-sessions', ICONS.sessions],
  ['toggle-tasks', ICONS.tasks],
] as const) {
  byId(id).innerHTML = svg;
}
byId('add-project').innerHTML = ICONS.plus;
byId('add-project').addEventListener('click', () => void addProject());
byId('empty-add').addEventListener('click', () => void addProject());
byId('new-claude').addEventListener('click', () => addPane('claude'));
byId('new-shell').addEventListener('click', () => addPane('shell'));
sidebarBtn.addEventListener('click', () => toggleSidebar('changes'));
sessionsBtn.addEventListener('click', () => toggleSidebar('sessions'));
tasksBtn.addEventListener('click', () => setTasksPanel(!state.tasksPanel));
sessionSearch.addEventListener('input', () => renderSessions());
sessionSearch.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter') {
    sessionListEl.querySelector<HTMLElement>('.srow:not(.gone)')?.click();
  } else if (e.key === 'Escape' && !sessionSearch.value && focusedPaneId) {
    e.preventDefault();
    focusPane(focusedPaneId);
  }
});
sessionFilterEl.addEventListener('change', () => {
  state.sessionFilter = sessionFilterEl.value as SessionFilter;
  renderSessions();
  save();
});
sessionSortEl.addEventListener('change', () => {
  state.sessionSort = sessionSortEl.value as SessionSort;
  renderSessions();
  save();
});
apOffBtn.addEventListener('click', () => setAutopilot(false));
apOnBtn.addEventListener('click', () => setAutopilot(true));
apLimit.addEventListener('change', () => {
  const project = activeProject();
  if (!project) return;
  project.autopilot.limit = Number(apLimit.value);
  save();
  void pump(project);
});
taskInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const title = taskInput.value.trim();
  if (!title) return;
  addTask(title);
  taskInput.value = '';
});
window.addEventListener('focus', () => void refreshGit());
setInterval(() => void refreshGit(), 5000);
setInterval(() => {
  for (const v of views.values()) {
    if (v.status !== 'running') continue;
    renderChip(v);
    const chip = sessionChips.get(v.pane.id);
    if (chip) paintChip(chip, v);
  }
  renderTaskChips();
}, 1000);

async function boot() {
  const saved = await api.loadState();
  if (saved) state = { ...state, ...saved };
  for (const project of state.projects) {
    project.tasks ??= [];
    project.autopilot ??= { on: false, limit: 2 };
    // Drop tiles whose session is gone; older states have no layout and show their first session.
    const ids = new Set(project.panes.map((p) => p.id));
    for (const id of panesIn(project.layout ?? null)) if (!ids.has(id)) project.layout = removePane(project.layout, id);
    project.layout ??= project.panes[0] ? leaf(project.panes[0].id) : null;
    // A start cut short by quitting left a card "in progress" with no session; put it back.
    for (const task of project.tasks) {
      const hasPane = Boolean(task.paneId && ids.has(task.paneId));
      if (!hasPane) task.paneId = undefined;
      if (task.status === 'doing' && !hasPane) task.status = task.cwd ? 'review' : 'todo';
    }
  }
  // Older states kept the Changes panel as a boolean.
  const side: unknown = state.sidebar;
  setSidebar(side === true || side === 'changes' ? 'changes' : side === 'sessions' ? 'sessions' : null);
  if (!(state.sessionFilter in FILTERS)) state.sessionFilter = 'active';
  if (!(state.sessionSort in SORTS)) state.sessionSort = 'status';
  sessionFilterEl.value = state.sessionFilter;
  sessionSortEl.value = state.sessionSort;
  setTasksPanel(state.tasksPanel);
  for (const project of state.projects) {
    for (const pane of project.panes) createView(project, pane);
    renderLayout(project);
    if (!project.icon || (!project.icon.custom && !project.icon.image)) void detectIcon(project);
  }
  const active = activeProject() ?? state.projects[0] ?? null;
  activateProject(active?.id ?? null);
  // Tasks in progress keep running in background projects too.
  for (const project of state.projects) {
    for (const task of project.tasks) {
      const v = task.status === 'doing' && task.paneId ? views.get(task.paneId) : undefined;
      if (v && !v.spawned) void spawn(v, v.pane.started);
    }
    void pump(project);
  }
  renderSessions();
}

void boot();
