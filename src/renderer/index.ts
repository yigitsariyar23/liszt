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
  BackgroundTask,
  ChatAnswer,
  ChatAsk,
  ChatImage,
  GitInfo,
  GitResult,
  GroupColor,
  HookEvent,
  LayoutNode,
  NotifyKind,
  PaneKind,
  PaneState,
  ProjectGroup,
  ProjectState,
  SessionFilter,
  SessionMark,
  SessionSort,
  SidebarView,
  TaskState,
  TaskStatus,
  TranscriptSession,
} from '../shared/types';
import { ChatView } from './chat';
import { h, iconEl } from './dom';
import { ICONS, KIND_GLYPH } from './icons';
import { leaf, panesIn, removePane, replacePane, splitPane, type Side } from './layout';
import { closeMenu, dropdown, showMenu, type MenuAnchor, type MenuEntry } from './menu';

declare global {
  interface Window {
    liszt: LisztApi;
  }
}

const api = window.liszt;

/** `waiting`: Claude ended its turn while background tasks it started still run; it goes on when they finish. */
type Status = 'starting' | 'idle' | 'running' | 'attention' | 'waiting' | 'exited';

/** Claude has work under way, whether it is acting, asking or waiting on its background tasks. */
const isWorking = (v: PaneView) => v.status === 'running' || v.status === 'attention' || v.status === 'waiting';
type DropZone = Side | 'center';

interface PaneView {
  pane: PaneState;
  project: ProjectState;
  el: HTMLElement;
  titleEl: HTMLElement;
  chipEl: HTMLElement;
  actionsEl: HTMLElement;
  dropEl: HTMLElement;
  /** The pane's terminal, made the first time it shows one. */
  term?: Terminal;
  fit?: FitAddon;
  termHost: HTMLElement;
  /** A Claude pane's conversation. */
  chat?: ChatView;
  /** Running `claude attach` on a background session rather than claude itself. */
  attached: boolean;
  /** The model a chat runs and the effort it was given in Liszt, for the model menu. */
  model?: string;
  effort?: string;
  status: Status;
  since: number;
  spawned: boolean;
  exitCode: number | null;
  /** Last thing the session did, for the Sessions overview. */
  activity: string;
  /** Tool calls in the current turn. */
  actions: number;
  /** A hook arrived since the last spawn, so hooks drive the status. */
  hooked: boolean;
  /** Running only because Claude Code listed the session busy, with no hook since: the activity before (see catchTurn). */
  unannounced?: string;
  /** When Claude was asked to name the session; the next terminal title is the name. */
  renaming?: number;
  /** Folder Claude asked to move this New Project session to; it moves when the turn ends. */
  moveTo?: string;
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
  /** A New Project session, told how to move itself to its project's folder. */
  newProject?: boolean;
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
  groups: [],
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
const apLimit = dropdown(
  byId('ap-limit'),
  ['1', '2', '3', '4'].map((n): [string, string] => [n, n]),
  (n) => {
    const project = activeProject();
    if (!project) return;
    project.autopilot.limit = Number(n);
    save();
    void pump(project);
  },
);
const sessionListEl = byId('session-list');
const sessionsCountEl = byId('sessions-count');
const sessionSearch = byId<HTMLInputElement>('session-search');
const sessionFilter = dropdown<SessionFilter>(
  byId('session-filter'),
  [
    ['active', 'Active'],
    ['liszt', 'In Liszt'],
    ['running', 'Running'],
    ['unread', 'Unread'],
    ['pinned', 'Pinned'],
    ['archived', 'Archived'],
    ['all', 'All'],
  ],
  (value) => {
    state.sessionFilter = value;
    renderSessions();
    save();
  },
);
const sessionSort = dropdown<SessionSort>(
  byId('session-sort'),
  [
    ['status', 'Status'],
    ['recent', 'Recent'],
    ['name', 'Name'],
    ['project', 'Project'],
  ],
  (value) => {
    state.sessionSort = value;
    renderSessions();
    save();
  },
);

/** Where a right-click happened, for the menu it opens. */
const pointer = (e: MouseEvent): MenuAnchor => ({ x: e.clientX, y: e.clientY });

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
  const viewBtn = iconEl(ICONS.shell, 'icon view-switch');
  if (pane.kind === 'claude') head.append(chipEl, actionsEl, viewBtn, unsplitBtn, closeBtn);
  else head.append(chipEl, actionsEl, unsplitBtn, closeBtn);
  const body = h('div', 'pane-body');
  const host = h('div', 'term-host');
  body.append(host);
  const dropEl = h('div', 'drop');
  dropEl.append(h('div', 'drop-zone'));
  el.append(head, body, dropEl);
  poolEl.append(el);

  let chat: ChatView | undefined;
  if (pane.kind === 'claude') {
    chat = new ChatView({
      send: (text, images, uuid) => sendChat(v, text, images, uuid),
      bash: async (command) => ((await ensureChat(v)) ? api.chatBash(pane.id, pane.cwd ?? project.path, command) : { stdout: '', stderr: 'The session is not running.', code: 1 }),
      files: () => api.chatFiles(pane.cwd ?? project.path),
      pickModel: (anchor) => void pickModel(v, anchor),
      stopTask: (taskId) => api.chatStopTask(pane.id, taskId),
      rewind: (index, text) => void rewindTo(v, index, text),
      answer: (id, a) => answerAsk(v, id, a),
      interrupt: () => api.chatInterrupt(pane.id),
      setMode: (mode) => api.chatMode(pane.id, mode),
      openExternal: (url) => api.openExternal(url),
      key: () => false,
      wheel: (e) => {
        if (!e.metaKey) return false;
        zoomByWheel(e);
        return true;
      },
    });
    chat.el.style.setProperty('--chat-size', `${state.fontSize + 1}px`);
    const chatHost = h('div', 'chat-host');
    chatHost.append(chat.el);
    body.append(chatHost);
  }

  const v: PaneView = {
    pane,
    project,
    el,
    titleEl,
    chipEl,
    actionsEl,
    dropEl,
    termHost: host,
    chat,
    status: 'starting',
    since: 0,
    spawned: false,
    exitCode: null,
    activity: '',
    actions: 0,
    hooked: false,
    attached: false,
  };
  views.set(pane.id, v);

  if (inTerminal(v)) ensureTerminal(v);
  paintView(v);
  chat?.el.addEventListener('focusin', () => setFocused(v));
  chat?.el.addEventListener('keydown', () => setUnread(v, false));
  el.addEventListener('mousedown', (e) => {
    setFocused(v);
    // A right-click opens the menu that can mark the session unread, so only a left click reads it.
    if (e.button === 0) setUnread(v, false);
  });
  closeBtn.addEventListener('click', () => closePane(v));
  viewBtn.addEventListener('click', () => switchView(v));
  unsplitBtn.addEventListener('click', () => unsplitPane(v));
  titleEl.addEventListener('dblclick', () => editTitle(v));
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void sessionMenu(v, 'head', pointer(e));
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

/** A pane shows a terminal: every shell, and a Claude session switched to Claude Code's own UI. */
const inTerminal = (v: PaneView) => v.pane.kind === 'shell' || Boolean(v.pane.terminal);

/** Makes a pane's terminal the first time it shows one. */
function ensureTerminal(v: PaneView): Terminal {
  if (v.term) return v.term;
  const { pane } = v;
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
  term.open(v.termHost);
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {
    // No WebGL: xterm keeps its DOM renderer.
  }
  v.term = term;
  v.fit = fit;

  term.onData((data) => api.write(pane.id, data));
  // Typing into a session reads it. What else the terminal sends does not: focus and mouse reports,
  // and its answers to the queries claude makes on starting.
  term.textarea?.addEventListener('keydown', () => setUnread(v, false));
  // Claude names the task it is working on in the terminal title ("✳ Fix login crash"); a shell
  // names itself.
  term.onTitleChange((raw) => {
    const clean = pane.kind === 'claude' ? raw.replace(/^[^\p{L}\p{N}]+/u, '').trim() : raw.trim();
    if (!clean || clean === pane.title || (pane.kind === 'claude' && /^claude( code)?$/i.test(clean))) return;
    pane.title = clean;
    // The name Claude was asked for replaces the one typed in Liszt.
    if (v.renaming && Date.now() - v.renaming < RENAME_WAIT) {
      v.renaming = undefined;
      pane.customTitle = undefined;
      renderSessions();
    }
    renderTitle(v);
    save();
  });
  term.attachCustomKeyEventHandler((e) => handleKey(v, e));
  // Cmd+scroll sizes the text like Cmd+= and Cmd+- instead of scrolling the terminal.
  term.attachCustomWheelEventHandler((e) => {
    if (!e.metaKey) return true;
    e.preventDefault();
    zoomByWheel(e);
    return false;
  });
  term.textarea?.addEventListener('focus', () => setFocused(v));
  return term;
}

/** Shows the pane's chat or its terminal, and the button that switches between them. */
function paintView(v: PaneView) {
  const terminal = inTerminal(v);
  v.el.classList.toggle('as-terminal', terminal);
  const btn = v.el.querySelector<HTMLElement>('.view-switch');
  if (btn) {
    btn.innerHTML = terminal ? ICONS.chat : ICONS.shell;
    btn.title = terminal ? 'Show as chat (⌘E)' : 'Show in the terminal (⌘E)';
  }
  if (terminal) scheduleFit(v);
}

/**
 * Moves a Claude session between the chat and Claude Code's terminal UI. Only one of them can run
 * the session, so the one showing stops and the other resumes the same conversation.
 */
function switchView(v: PaneView) {
  if (v.pane.kind !== 'claude') return;
  const to = v.pane.terminal ? 'chat' : 'terminal';
  if (isWorking(v) && !confirm(`"${displayTitle(v)}" is still working. Switching stops its turn and the session goes on in the ${to}. Switch?`)) return;
  v.pane.terminal = !v.pane.terminal || undefined;
  // The terminal gets a background session of its own, resumed from where the chat left off; one
  // the pane had before stopped when it went to the chat.
  if (v.pane.terminal) v.pane.bgId = undefined;
  save();
  if (v.pane.terminal) ensureTerminal(v).reset();
  paintView(v);
  if (v.spawned) {
    api.kill(v.pane.id);
    void spawn(v, continues(v.pane));
  }
  focusView(v);
}

function scheduleFit(v: PaneView) {
  if (!v.term || !v.fit) return;
  const { term, fit } = v;
  requestAnimationFrame(() => {
    // Background tabs and hidden projects measure as zero; they fit again once shown.
    if (!v.el.isConnected || v.el.offsetParent === null) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    if (v.spawned) api.resize(v.pane.id, term.cols, term.rows);
  });
}

/** Gives the keyboard to a pane: its composer or its terminal. */
const focusView = (v: PaneView) => (inTerminal(v) ? v.term?.focus() : v.chat?.focus());

/** A Claude pane that has a session goes on with it, resumed by id. */
const continues = (pane: PaneState) => pane.kind === 'claude' && (pane.started || Boolean(pane.bgId));

async function spawn(v: PaneView, resume: boolean, prompt?: string, resumeAt?: string) {
  // A session id is only reused for --resume; a fresh start always gets a new one so it never
  // collides with an id claude has already seen.
  if (v.pane.kind === 'claude' && !resume) {
    // Left alone, a background session an earlier version started would keep running with no pane.
    if (v.pane.bgId) api.stopBackground(v.pane.sessionId, v.pane.bgId);
    v.pane.sessionId = uuid();
    v.pane.started = false;
    v.pane.bgId = undefined;
    save();
  }
  v.spawned = true;
  v.exitCode = null;
  v.attached = false;
  v.hooked = false;
  v.unannounced = undefined;
  setStatus(v, v.pane.kind === 'claude' ? 'starting' : 'idle');
  try {
    v.fit?.fit();
  } catch {
    // Not visible yet; the ResizeObserver resizes the pty once it is.
  }
  const cwd = v.pane.cwd ?? v.project.path;
  // The conversation so far is read while the session starts.
  const chat = inTerminal(v) ? undefined : v.chat;
  const history = chat && resume ? api.chatHistory(v.pane.sessionId, cwd) : null;
  resumeAt ??= resume ? v.pane.rewoundTo : undefined;
  chat?.clear();
  if (chat && prompt && !resume) chat.sent(prompt);
  const res = await api.spawn({
    paneId: v.pane.id,
    cwd,
    kind: v.pane.kind,
    sessionId: v.pane.sessionId,
    resume,
    cols: v.term?.cols ?? 80,
    rows: v.term?.rows ?? 24,
    prompt,
    transcript: v.pane.transcript,
    attach: resume ? v.pane.bgId : undefined,
    newProject: v.pane.newProject,
    terminal: v.pane.kind === 'claude' && inTerminal(v),
    resumeAt,
  });
  // Closed while claude started.
  if (views.get(v.pane.id) !== v) return;
  // The pane's background session is still working: it goes on in the terminal, and the user
  // switches to the chat once it is done.
  if (!res.ok && res.error === 'busy-in-background') {
    v.pane.terminal = true;
    save();
    ensureTerminal(v);
    paintView(v);
    return spawn(v, resume, prompt);
  }
  if (res.ok && v.pane.kind === 'claude') {
    if (resume && !res.resumed) {
      v.pane.started = false;
      v.pane.transcript = undefined;
    }
    v.pane.sessionId = res.sessionId;
    v.pane.bgId = res.bgId;
    v.attached = Boolean(res.bgId);
    if (res.live?.attached) v.pane.started = true;
    save();
    if (history && res.resumed) {
      const messages = await history;
      if (views.get(v.pane.id) !== v || inTerminal(v)) return;
      const cut = v.pane.rewoundTo ? messages.findIndex((m) => m.uuid === v.pane.rewoundTo) : -1;
      chat?.history(cut >= 0 ? messages.slice(0, cut + 1) : messages);
    }
    // A chat that kept running in the session host sends no SessionStart; it is as the host says.
    if (res.live?.attached && v.status === 'starting') {
      if (res.live.busy) {
        v.activity = 'Working';
        setStatus(v, 'running');
        chat?.setBusy(true);
      } else if (v.pane.working) {
        // It finished while Liszt was closed.
        v.activity = 'Finished';
        finishTurn(v);
      } else setStatus(v, 'idle');
    }
    syncAttached(v);
  }
  if (!res.ok) {
    if (chat) chat.error(`Could not start: ${res.error}`);
    else v.term?.writeln(`\r\n\x1b[31mCould not start: ${res.error}\x1b[0m`);
    v.exitCode = -1;
    setStatus(v, 'exited');
  }
}

function restart(v: PaneView, resume: boolean) {
  v.term?.reset();
  v.chat?.clear();
  if (!resume) {
    v.pane.title = '';
    renderTitle(v);
  }
  void spawn(v, resume);
  focusView(v);
}

function setStatus(v: PaneView, status: Status, keepSince = false) {
  if (!(keepSince && v.since)) v.since = Date.now();
  v.status = status;
  // Starting and exiting say nothing about the session, and quitting Liszt exits every pane.
  if (status !== 'starting' && status !== 'exited' && Boolean(v.pane.working) !== isWorking(v)) {
    v.pane.working = isWorking(v) || undefined;
    save();
  }
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

/** An idle session whose work went out shows that instead of Idle. */
const SHIPPED_TEXT: Record<NonNullable<SessionMark['shipped']>, string> = { pushed: 'Pushed', merged: 'Merged' };
const shippedOf = (sessionId: string | undefined) => (sessionId ? state.sessionMarks[sessionId]?.shipped : undefined);
const shownShipped = (v: PaneView) => (v.status === 'idle' && !isUnread(v) ? shippedOf(v.pane.sessionId) : undefined);

function chipText(v: PaneView): string {
  switch (v.status) {
    case 'running':
      return `Running · ${duration(Date.now() - v.since)}`;
    case 'attention':
      return 'Needs you';
    case 'waiting':
      return `Waiting · ${duration(Date.now() - v.since)}`;
    case 'idle':
      return isUnread(v) ? 'Unread' : (shownShipped(v) ? SHIPPED_TEXT[shownShipped(v)!] : 'Idle');
    case 'exited':
      return v.exitCode ? `Exited (${v.exitCode})` : 'Exited';
    default:
      return 'Starting';
  }
}

const chipClass = (v: PaneView) => `chip ${isUnread(v) ? 'unread' : shownShipped(v) ?? v.status}`;

function paintChip(el: HTMLElement, v: PaneView) {
  el.className = chipClass(v);
  el.textContent = chipText(v);
  // Says what it waits on.
  el.title = v.status === 'waiting' ? v.activity : '';
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

const dotClass = (v: PaneView) => {
  if (isUnread(v)) return 'unread';
  if (['running', 'attention', 'waiting', 'exited'].includes(v.status)) return v.status;
  return shownShipped(v) ?? '';
};

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
  if (continues(v.pane)) button('Resume', () => restart(v, true));
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
      const back = focusedPaneId ? views.get(focusedPaneId) : undefined;
      if (back) focusView(back);
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

/** Claude Code takes typed commands while its turn is over, background tasks or not. */
const atPrompt = (v: PaneView) => v.pane.kind === 'claude' && v.pane.started && v.spawned && (v.status === 'idle' || v.status === 'waiting');

/** How long the name asked of Claude may take to arrive; the model makes it up. */
const RENAME_WAIT = 60_000;

/**
 * Has Claude Code name the session the way `/rename` with no name does: it asks the model for a
 * short name and keeps it as the session's name, which the pane takes up in place of a name typed
 * in Liszt once the command's turn ends. The model can come back without one, and then nothing
 * changes.
 */
function renameWithClaude(v: PaneView) {
  if (inTerminal(v) && v.term) return void renameInTerminal(v, v.term);
  v.renaming = Date.now();
  sendChat(v, '/rename', []);
}

/** A rule of Claude Code's prompt box; the top one carries the session's name once it has one. */
const RULE = /^\s*─{4,}(?:.*─)?\s*$/;

/**
 * Claude Code's prompt box as it is on screen: a `❯` line and the lines of the draft under it,
 * between two rules. The draft leaves out the dim placeholder and the cursor; `stashed` is the note
 * above the box saying Ctrl+S put a draft aside. Null when the box is not showing, as when a menu
 * or a question has the keyboard.
 */
function promptBox(term: Terminal): { draft: string; stashed: boolean } | null {
  const buf = term.buffer.active;
  const bottom = buf.baseY + term.rows - 1;
  const text = (y: number) => buf.getLine(y)?.translateToString(true) ?? '';
  for (let y = bottom; y > bottom - term.rows && y > 0; y--) {
    if (!text(y).trimStart().startsWith('❯') || !RULE.test(text(y - 1))) continue;
    let draft = '';
    for (let row = y; row <= bottom && !RULE.test(text(row)); row++) {
      const line = buf.getLine(row)!;
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)!;
        if (!cell.isDim() && !cell.isInverse()) draft += cell.getChars() || ' ';
      }
      draft += '\n';
    }
    return { draft: draft.trim().replace(/^❯/, '').trim(), stashed: text(y - 2).includes('› stashed') };
  }
  return null;
}

/**
 * Rename with Claude in the terminal UI: Claude Code sets the name it gets as the terminal title,
 * which the pane takes up in place of a name typed in Liszt. The model can come back without one,
 * and then nothing changes. The command is typed into the prompt box, so a draft there is first put aside
 * with Ctrl+S, and Claude Code brings it back once the command has run.
 */
async function renameInTerminal(v: PaneView, term: Terminal) {
  const box = promptBox(term);
  if (!box) return alert(`"${displayTitle(v)}" is not at its prompt. Close what is open in it, then ask again.`);
  // Ctrl+S keeps one draft aside, so it would drop the one already there.
  if (box.draft && box.stashed) return alert(`"${displayTitle(v)}" has a draft in its prompt and another stashed with Ctrl+S. Send or clear the draft, then ask again.`);
  v.renaming = Date.now();
  // Sent all at once, the keys would read as a paste and the Enter as a new line.
  const keys = [...(box.draft ? ['\x13'] : []), '/rename', '\r'];
  for (const [i, k] of keys.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 250));
    if (views.get(v.pane.id) !== v) return;
    api.write(v.pane.id, k);
  }
}

async function sessionMenu(v: PaneView, from: 'tab' | 'head', at: MenuAnchor) {
  const project = v.project;
  const visible = panesIn(project.layout);
  const anchor = splitAnchor(project);
  const canSplit = Boolean(anchor && anchor !== v.pane.id);
  const entries: MenuEntry[] = [{ label: 'Rename…', id: 'rename', key: 'r' }];
  if (v.pane.kind === 'claude') entries.push({ label: 'Rename with Claude', id: 'rename-claude', key: 'l', enabled: atPrompt(v) });
  if (v.pane.customTitle) entries.push({ label: 'Use Automatic Name', id: 'reset-name', key: 'n' });
  entries.push(
    { label: v.pane.unread ? 'Mark as Read' : 'Mark as Unread', id: 'unread', key: 'u' },
    'separator',
    { label: 'Split Right', id: 'split-right', key: 's', enabled: canSplit },
    { label: 'Split Down', id: 'split-down', key: 'b', enabled: canSplit },
    { label: 'Take Out of Split', id: 'unsplit', key: 't', enabled: visible.length > 1 && visible.includes(v.pane.id) },
    'separator',
    { label: 'Reveal in Finder', id: 'reveal', key: 'f' },
  );
  if (v.pane.kind === 'claude') entries.push({ label: v.pane.terminal ? 'Show as Chat' : 'Show in Terminal', id: 'toggle-view', key: 'e' });
  if (v.pane.kind === 'claude') entries.push({ label: 'Copy Session ID', id: 'copy-id', key: 'i', enabled: v.pane.started });
  entries.push('separator', { label: 'Close Session', id: 'close', key: 'c' }, { label: 'Close Other Sessions', id: 'close-others', key: 'o', enabled: project.panes.length > 1 });
  const choice = await showMenu(entries, at);
  // The session may have been closed while the menu was open.
  if (views.get(v.pane.id) !== v) return;
  switch (choice) {
    case 'rename':
      return from === 'tab' ? renameTab(v) : editTitle(v);
    case 'rename-claude':
      return void renameWithClaude(v);
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
    case 'toggle-view':
      return switchView(v);
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
  renderSessions();
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
  focusView(v);
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
  if (hadFocus && focusedPaneId && visible.includes(focusedPaneId)) views.get(focusedPaneId) && focusView(views.get(focusedPaneId)!);
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
    newProject: opts.newProject || undefined,
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
  if (ask && isWorking(v) && !confirm(`"${displayTitle(v)}" is still working. Close it?`)) return false;
  const project = v.project;
  const index = project.panes.indexOf(v.pane);
  const visible = panesIn(project.layout);
  api.kill(v.pane.id);
  if (v.pane.kind === 'claude' && stop) api.stopBackground(v.pane.sessionId, v.pane.bgId);
  keepUnread(v.pane);
  v.term?.dispose();
  v.chat?.exited('Closed');
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
      void sessionMenu(v, 'tab', pointer(e));
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
  if (list.some((v) => v.status === 'waiting')) return 'waiting';
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

// Project tabs are dragged to reorder them, the same way session tabs are. They can be gathered into
// named, coloured groups, like a browser's tab groups: the group's own tab leads its projects, and
// clicking it collapses them into it. A dragged project joins the group of the tab it is dropped on;
// dragging a group's tab moves its projects together.
const PROJECT_DRAG_TYPE = 'application/x-liszt-project';
const GROUP_DRAG_TYPE = 'application/x-liszt-group';
const GROUP_COLORS: Array<[GroupColor, string, string]> = [
  ['grey', 'Grey', '#a1a1aa'],
  ['blue', 'Blue', '#6fa3e6'],
  ['green', 'Green', '#6cc287'],
  ['yellow', 'Yellow', '#e2b84f'],
  ['orange', 'Orange', '#ea925e'],
  ['red', 'Red', '#e36d6d'],
  ['pink', 'Pink', '#e48fbf'],
  ['purple', 'Purple', '#b394ec'],
  ['cyan', 'Cyan', '#5fc4c4'],
];
const projectTabEls = new Map<string, HTMLElement>();
const groupTabEls = new Map<string, HTMLElement>();
let dragProjectId: string | null = null;
let dragGroupId: string | null = null;
let tabsDirty = false;

const groupOf = (project: ProjectState) => state.groups.find((g) => g.id === project.groupId);
const groupMembers = (group: ProjectGroup) => state.projects.filter((p) => p.groupId === group.id);
const groupColor = (group: ProjectGroup) => (GROUP_COLORS.find(([c]) => c === group.color) ?? GROUP_COLORS[0])[2];

/** A group's name, or what it holds when it has none. */
function groupLabel(group: ProjectGroup): string {
  if (group.name) return group.name;
  const [first, ...rest] = groupMembers(group);
  return rest.length ? `${first.name} + ${rest.length} more` : first.name;
}

/** The most urgent status among some projects. */
function groupStatus(projects: ProjectState[]): string {
  const all = projects.map(projectStatus);
  return ['attention', 'running', 'waiting', 'unread'].find((s) => all.includes(s)) ?? '';
}

/** Keeps each group's projects together where its first one sits, and drops groups left empty. */
function normalizeGroups() {
  const known = new Set(state.groups.map((g) => g.id));
  const placed = new Set<string>();
  const order: ProjectState[] = [];
  for (const p of state.projects) {
    if (p.groupId && !known.has(p.groupId)) p.groupId = undefined;
    if (!p.groupId) order.push(p);
    else if (!placed.has(p.groupId)) {
      placed.add(p.groupId);
      order.push(...state.projects.filter((q) => q.groupId === p.groupId));
    }
  }
  state.projects = order;
  state.groups = state.groups.filter((g) => placed.has(g.id));
}

function renderTabs() {
  // Replacing the tab being dragged or renamed would cancel that; rebuild once it ends.
  if (dragProjectId || dragGroupId || tabsEl.querySelector('[contenteditable="true"]')) {
    tabsDirty = true;
    return;
  }
  tabsDirty = false;
  projectTabEls.clear();
  groupTabEls.clear();
  const els: HTMLElement[] = [];
  for (let i = 0; i < state.projects.length; ) {
    const group = groupOf(state.projects[i]);
    if (!group) {
      els.push(projectTab(state.projects[i++]));
      continue;
    }
    const members: ProjectState[] = [];
    while (state.projects[i]?.groupId === group.id) members.push(state.projects[i++]);
    els.push(groupBox(group, members));
  }
  tabsEl.replaceChildren(...els);
}

function projectTab(p: ProjectState): HTMLElement {
  const tab = h('div', `tab${p.id === state.activeProjectId ? ' active' : ''}${p.folded ? ' folded' : ''}`);
  tab.draggable = true;
  tab.title = `${p.name}\n${p.path}\nDouble-click to ${p.folded ? 'unfold' : 'fold'}, drag to reorder or into a group, right-click for more`;
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
  tab.addEventListener('dblclick', (e) => {
    if (!close.contains(e.target as Node) && !name.isContentEditable) foldProjects([p], !p.folded);
  });
  tab.addEventListener('auxclick', (e) => e.button === 1 && closeProject(p));
  tab.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void projectMenu(p, pointer(e));
  });
  tab.addEventListener('dragstart', (e) => {
    dragProjectId = p.id;
    e.dataTransfer?.setData(PROJECT_DRAG_TYPE, p.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    tab.classList.add('dragging');
  });
  tab.addEventListener('dragend', endProjectDrag);
  dropTarget(
    tab,
    () => Boolean(dragProjectId || (dragGroupId && dragGroupId !== p.groupId)),
    (project, group, after) => (project ? dropOnProject(p.id, project, after) : group && moveGroup(group, p, after)),
  );
  projectTabEls.set(p.id, tab);
  return tab;
}

/** A group's tab followed by its projects' tabs, or only the open one of them while it is collapsed. */
function groupBox(group: ProjectGroup, members: ProjectState[]): HTMLElement {
  const box = h('div', `tgroup${group.collapsed ? ' collapsed' : ''}`);
  box.style.setProperty('--group', groupColor(group));
  const chip = h('div', 'tgroup-chip');
  chip.draggable = true;
  const name = h('span', 'tgroup-name', group.name);
  chip.append(name);
  if (group.collapsed) chip.append(h('span', 'tgroup-count', String(members.length)));
  const count = `${members.length} ${members.length === 1 ? 'project' : 'projects'}`;
  chip.title = `${groupLabel(group)} · ${count}\nClick to ${group.collapsed ? 'expand' : 'collapse'}, drag to move, right-click for more`;
  chip.addEventListener('click', () => name.isContentEditable || toggleGroup(group));
  chip.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void groupMenu(group, pointer(e));
  });
  chip.addEventListener('dragstart', (e) => {
    dragGroupId = group.id;
    e.dataTransfer?.setData(GROUP_DRAG_TYPE, group.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    box.classList.add('dragging');
  });
  chip.addEventListener('dragend', endProjectDrag);
  // Dropped on the right half a project joins the group as its first; on the left half it goes before the group.
  dropTarget(
    chip,
    () => Boolean(dragProjectId || (dragGroupId && dragGroupId !== group.id)),
    (project, other, after) => (project ? dropOnGroup(group, project, after) : other && moveGroup(other, members[0], after)),
  );
  groupTabEls.set(group.id, chip);
  box.append(chip);
  // The open project stays in sight when its group collapses; the dot speaks for the hidden ones.
  const shown = group.collapsed ? members.filter((p) => p.id === state.activeProjectId) : members;
  const status = group.collapsed ? groupStatus(members.filter((p) => !shown.includes(p))) : '';
  if (status) box.append(h('span', `dot ${status}`));
  box.append(...shown.map(projectTab));
  return box;
}

/** Lets a tab take a dragged project or group, marking which side of it the drop lands on. */
function dropTarget(el: HTMLElement, accepts: () => boolean, drop: (project: string | null, group: string | null, after: boolean) => void) {
  const dropsAfter = (e: DragEvent) => {
    const r = el.getBoundingClientRect();
    return e.clientX > r.left + r.width / 2;
  };
  el.addEventListener('dragover', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    const after = dropsAfter(e);
    el.classList.toggle('drop-after', after);
    el.classList.toggle('drop-before', !after);
  });
  // Moving onto the tab's own name or icon also fires a dragleave; only leaving the tab counts.
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget as Node | null)) el.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('drop', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    const [project, group] = [dragProjectId, dragGroupId];
    const after = dropsAfter(e);
    endProjectDrag();
    drop(project, group, after);
  });
}

function endProjectDrag() {
  dragProjectId = null;
  dragGroupId = null;
  for (const el of tabsEl.querySelectorAll('.drop-before, .drop-after, .dragging')) el.classList.remove('drop-before', 'drop-after', 'dragging');
  if (tabsDirty) renderTabs();
}

/** Puts groups and the order of their projects right after a change, then shows and saves it. */
function regroup() {
  normalizeGroups();
  renderTabs();
  save();
}

function dropOnProject(targetId: string, draggedId: string, after: boolean) {
  const target = state.projects.find((p) => p.id === targetId);
  const moved = state.projects.find((p) => p.id === draggedId);
  if (!target || !moved || moved === target) return;
  state.projects.splice(state.projects.indexOf(moved), 1);
  state.projects.splice(state.projects.indexOf(target) + (after ? 1 : 0), 0, moved);
  // Dropped among a group's tabs it joins that group; dropped among loose tabs it leaves its own.
  moved.groupId = target.groupId;
  regroup();
}

/** A project dropped on a group's tab joins the group as its first project, or goes just before the group. */
function dropOnGroup(group: ProjectGroup, draggedId: string, into: boolean) {
  const moved = state.projects.find((p) => p.id === draggedId);
  if (!moved) return;
  const [first] = groupMembers(group).filter((p) => p !== moved);
  if (first) {
    state.projects.splice(state.projects.indexOf(moved), 1);
    state.projects.splice(state.projects.indexOf(first), 0, moved);
  }
  moved.groupId = into ? group.id : undefined;
  regroup();
}

/** Moves a group's projects together, before or after a project's tab, or that project's whole group. */
function moveGroup(groupId: string, target: ProjectState, after: boolean) {
  if (target.groupId === groupId) return;
  const block = state.projects.filter((p) => p.groupId === groupId);
  const rest = state.projects.filter((p) => p.groupId !== groupId);
  const around = target.groupId ? rest.filter((p) => p.groupId === target.groupId) : [target];
  rest.splice(after ? rest.indexOf(around[around.length - 1]) + 1 : rest.indexOf(around[0]), 0, ...block);
  state.projects = rest;
  regroup();
}

/** Starts a group holding this project and lets the user name it right away. */
function createGroup(project: ProjectState) {
  const used = new Set(state.groups.map((g) => g.color));
  const [color] = GROUP_COLORS.find(([c]) => !used.has(c)) ?? GROUP_COLORS[state.groups.length % GROUP_COLORS.length];
  const group: ProjectGroup = { id: uuid(), name: '', color };
  state.groups.push(group);
  project.groupId = group.id;
  regroup();
  renameGroup(group);
}

/** Moves a project to the end of a group. */
function joinGroup(project: ProjectState, group: ProjectGroup) {
  const last = groupMembers(group).at(-1);
  if (!last || last === project) return;
  state.projects.splice(state.projects.indexOf(project), 1);
  state.projects.splice(state.projects.indexOf(last) + 1, 0, project);
  project.groupId = group.id;
  regroup();
}

/** Takes a project out of its group, placing it right after the group so the others stay where they are. */
function leaveGroup(project: ProjectState) {
  const group = groupOf(project);
  if (!group) return;
  const last = groupMembers(group).at(-1)!;
  if (last !== project) {
    state.projects.splice(state.projects.indexOf(project), 1);
    state.projects.splice(state.projects.indexOf(last) + 1, 0, project);
  }
  project.groupId = undefined;
  regroup();
}

function ungroup(group: ProjectGroup) {
  for (const p of groupMembers(group)) p.groupId = undefined;
  regroup();
}

function toggleGroup(group: ProjectGroup) {
  group.collapsed = !group.collapsed || undefined;
  renderTabs();
  save();
}

/** Renames a group on its tab; an empty name leaves only its colour. */
function renameGroup(group: ProjectGroup) {
  const name = groupTabEls.get(group.id)?.querySelector<HTMLElement>('.tgroup-name');
  if (!name) return;
  editText(name, group.name, (text) => {
    if (text !== null) group.name = text;
    renderTabs();
    save();
  });
}

function closeGroup(group: ProjectGroup) {
  const members = groupMembers(group);
  const busy = members.filter(projectBusy).map((p) => p.name);
  if (busy.length && !confirm(`${busy.join(', ')} ${busy.length === 1 ? 'has' : 'have'} sessions still working. Close the group's projects?`)) return;
  for (const p of members) closeProject(p, { ask: false });
}

async function groupMenu(group: ProjectGroup, at: MenuAnchor) {
  const choice = await showMenu(
    [
      { label: 'Rename…', id: 'rename', key: 'r' },
      {
        label: 'Color',
        key: 'k',
        submenu: GROUP_COLORS.map(([color, label, css]) => ({ label, id: `color:${color}`, swatch: css, checked: color === group.color })),
      },
      { label: group.collapsed ? 'Expand' : 'Collapse', id: 'collapse', key: 'e' },
      'separator',
      { label: 'Add Project to Group…', id: 'add', key: 'p' },
      'separator',
      { label: 'Ungroup', id: 'ungroup', key: 'u' },
      { label: 'Close Group', id: 'close', key: 'c' },
    ],
    at,
  );
  // The group may have gone while the menu was open.
  if (!choice || !state.groups.includes(group)) return;
  if (choice.startsWith('color:')) {
    group.color = choice.slice('color:'.length) as GroupColor;
    renderTabs();
    save();
    return;
  }
  switch (choice) {
    case 'rename':
      return renameGroup(group);
    case 'collapse':
      return toggleGroup(group);
    case 'add':
      return void addProject(group);
    case 'ungroup':
      return ungroup(group);
    case 'close':
      return closeGroup(group);
  }
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

async function projectMenu(project: ProjectState, at: MenuAnchor) {
  const others = state.projects.filter((p) => p !== project);
  const otherGroups = state.groups.filter((g) => g.id !== project.groupId);
  const entries: MenuEntry[] = [{ label: 'Rename…', id: 'rename', key: 'r' }];
  if (project.name !== folderName(project.path)) entries.push({ label: 'Use Folder Name', id: 'reset-name', key: 'n' });
  entries.push(
    'separator',
    otherGroups.length
      ? {
          label: project.groupId ? 'Move to Group' : 'Add to Group',
          key: 'g',
          submenu: [
            { label: 'New Group', id: 'group-new' },
            'separator',
            ...otherGroups.map((g) => ({ label: groupLabel(g), id: `group:${g.id}`, swatch: groupColor(g) })),
          ],
        }
      : { label: project.groupId ? 'Move to New Group' : 'Add to New Group', id: 'group-new', key: 'g' },
  );
  if (project.groupId) entries.push({ label: 'Remove from Group', id: 'ungroup', key: 'u' });
  entries.push(
    'separator',
    { label: project.folded ? 'Unfold' : 'Fold', id: 'fold', key: 'e' },
    { label: 'Fold Others', id: 'fold-others', key: 'o', enabled: others.some((p) => !p.folded) },
    { label: 'Unfold All', id: 'unfold-all', key: 'a', enabled: state.projects.some((p) => p.folded) },
    'separator',
    { label: 'Choose Icon…', id: 'icon-choose', key: 'i' },
    { label: 'Detect Icon Again', id: 'icon-detect' },
    'separator',
    { label: 'Reveal in Finder', id: 'reveal', key: 'f' },
    'separator',
    { label: 'Close Project', id: 'close', key: 'c' },
  );
  const choice = await showMenu(entries, at);
  // The project may have been closed while the menu was open.
  if (!choice || !state.projects.includes(project)) return;
  if (choice.startsWith('group:')) {
    const group = state.groups.find((g) => g.id === choice.slice('group:'.length));
    if (group) joinGroup(project, group);
    return;
  }
  switch (choice) {
    case 'rename':
      return renameProject(project);
    case 'reset-name':
      return setProjectName(project, folderName(project.path));
    case 'group-new':
      return createGroup(project);
    case 'ungroup':
      return leaveGroup(project);
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
      if (!v.spawned) void spawn(v, continues(pane));
    }
    for (const paneId of panesIn(project.layout)) scheduleFit(views.get(paneId)!);
    // Older states can still point at a pane that was closed.
    const last = project.activePaneId ? views.get(project.activePaneId) : undefined;
    focusPane(last && isVisible(last) ? last.pane.id : panesIn(project.layout)[0]);
  }
  renderTabs();
  renderSessionBar();
  renderSessions();
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

/** Picked from a group's menu, the folder goes into that group, even when it is already open. */
async function addProject(group?: ProjectGroup) {
  const dir = await api.pickFolder();
  if (!dir) return;
  const existing = state.projects.find((p) => p.path === dir);
  const project = existing ?? createProject(dir);
  if (group && state.groups.includes(group) && project.groupId !== group.id) joinGroup(project, group);
  activateProject(project.id);
  if (!existing) addPane('claude', project);
}

/** Opens a Claude session in ~/other-projects that makes a new project's folder and moves into it. */
async function newProject() {
  const dir = await api.newProjectFolder();
  const project = projectFor(dir) ?? createProject(dir);
  if (state.activeProjectId !== project.id) activateProject(project.id);
  const v = addPane('claude', project, { newProject: true });
  if (!v) return;
  v.pane.title = 'New project';
  renderTitle(v);
  save();
}

/** Claude made the project's folder; the session moves there now if its turn is over, else when it ends. */
function onMoveRequest(paneId: string, dir: string) {
  const v = views.get(paneId);
  if (!v) return;
  v.moveTo = dir;
  if (!isWorking(v)) void moveSession(v);
}

/**
 * Reopens a session in the project of the folder Claude moved it to, opening that folder as a
 * project if needed. The session is stopped and its transcript filed under the new folder, so it
 * resumes there; the old pane goes, and the project tab follows it when the old one was in view.
 */
async function moveSession(v: PaneView) {
  const dir = v.moveTo!;
  v.moveTo = undefined;
  const { sessionId, bgId, title, customTitle, unread } = v.pane;
  api.kill(v.pane.id);
  v.activity = `Moving to ${folderName(dir)}`;
  setStatus(v, 'starting');
  const res = await api.moveSession(sessionId, bgId, dir);
  if (views.get(v.pane.id) !== v) return;
  if (!res.ok) {
    v.chat?.error(`Could not move the session to ${dir}: ${res.error}`);
    void spawn(v, true);
    return;
  }
  const follow = state.activeProjectId === v.project.id;
  closePane(v, { ask: false, stop: false });
  const project = projectFor(dir) ?? createProject(dir);
  if (follow) activateProject(project.id);
  const moved = addPane('claude', project, { sessionId, title: customTitle });
  if (!moved) return;
  moved.pane.title = title;
  moved.pane.transcript = res.transcript;
  moved.pane.unread = unread;
  markUnread(sessionId, false);
  renderTitle(moved);
  renderTabs();
  save();
}

const projectBusy = (project: ProjectState) => project.panes.some((p) => views.has(p.id) && isWorking(views.get(p.id)!));

/** `ask: false` skips the question about working sessions when the caller already asked. */
function closeProject(project: ProjectState, { ask = true } = {}) {
  if (ask && projectBusy(project) && !confirm(`${project.name} has sessions still working. Close the project?`)) return;
  for (const pane of project.panes) {
    const v = views.get(pane.id);
    if (!v) continue;
    api.kill(pane.id);
    if (pane.kind === 'claude') api.stopBackground(pane.sessionId, pane.bgId);
    keepUnread(pane);
    v.term?.dispose();
    v.el.remove();
    views.delete(pane.id);
  }
  stages.get(project.id)?.remove();
  stages.delete(project.id);
  const i = state.projects.indexOf(project);
  state.projects.splice(i, 1);
  // A group left empty goes with its last project.
  normalizeGroups();
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
  apLimit.set(String(project.autopilot.limit));

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
// elsewhere (other terminals, the desktop app, background sessions) and the ones nothing runs:
// finished background sessions, every session the Claude desktop app keeps, archived and pinned
// ones included, and every other session Claude Code still has a transcript of, such as one that
// ran in a terminal and ended. A row shows its pane, or opens the session in a new pane of its
// folder's project: background sessions with `claude attach`, the rest with `claude --resume`.
// A row's menu marks its session unread, or closes, archives or deletes it. Marks are Liszt's
// own: it never writes to the Claude app's files, and it keeps the title and folder of a session
// archived from it.

const STATUS_ORDER: Record<Status, number> = { attention: 0, running: 1, waiting: 2, starting: 3, idle: 4, exited: 5 };
/** Replies waiting to be read sort right after the working sessions. */
const UNREAD_RANK = 2.5;
/** Sessions nothing runs sort after every running one. */
const NOT_RUNNING = 6;
/** What ran a session, by the entrypoint its transcript records. */
const SOURCES: Record<string, string> = {
  cli: 'Terminal',
  'claude-desktop': 'Claude app',
  'sdk-cli': 'Agent SDK',
  'sdk-ts': 'Agent SDK',
  'sdk-py': 'Agent SDK',
};
const sessionChips = new Map<string, HTMLElement>();
/** Sessions being closed or deleted, with what the row says meanwhile. */
const pendingSessions = new Map<string, string>();
/** Rows picked with Cmd- and Shift-click, for acting on several at once; the anchor is where a Shift-click range starts. */
const selectedSessions = new Set<string>();
let selectionAnchor: string | undefined;
/** Session ids in the order the panel shows them, for Shift-click ranges. */
let shownSessionIds: string[] = [];

let agents: AgentSession[] = [];
/** When `agents` was asked for. */
let agentsAsked = 0;
let appSessions: AppSession[] = [];
let transcriptSessions: TranscriptSession[] = [];

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
  /** Marked unread; shown so once nothing is working in it. */
  unread: boolean;
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
  // One whose folder or conversation is gone can only be seen, so it waits under All.
  active: (r) => (!r.archived || r.group !== 'stopped') && Boolean(r.open),
  liszt: (r) => r.group === 'liszt',
  running: (r) => r.live,
  unread: (r) => r.unread,
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
/** Marked unread while no Liszt pane has it; a pane keeps its own. */
const isMarkedUnread = (sessionId: string) => Boolean(state.sessionMarks[sessionId]?.unread);

function markUnread(sessionId: string, unread: boolean) {
  const mark = state.sessionMarks[sessionId];
  if (Boolean(mark?.unread) === unread) return;
  if (unread) state.sessionMarks[sessionId] = { ...mark, unread, at: mark?.at ?? Date.now() };
  // A mark that said nothing else goes.
  else if (mark.archived === undefined && !mark.deleted && !mark.cwd && !mark.shipped) delete state.sessionMarks[sessionId];
  else mark.unread = undefined;
}

/** Records what went out of a session, or clears it (no value) when the session starts new work. */
function markShipped(sessionId: string, shipped?: SessionMark['shipped']) {
  const mark = state.sessionMarks[sessionId];
  if (mark?.shipped === shipped) return;
  if (shipped) state.sessionMarks[sessionId] = { ...mark, shipped, at: mark?.at ?? Date.now() };
  else if (mark.archived === undefined && !mark.deleted && !mark.cwd && !mark.unread) delete state.sessionMarks[sessionId];
  else mark.shipped = undefined;
  save();
}

/** A merge outranks a push: `gh pr merge` ends the work, a `git push` before it is only part of it. */
const PUSH = /\bgit\s+push\b/;
const MERGE = /\bgh\s+pr\s+merge\b/;
function shippedBy(command: string): SessionMark['shipped'] | undefined {
  if (MERGE.test(command)) return 'merged';
  return PUSH.test(command) ? 'pushed' : undefined;
}

/** A pane that goes away leaves its session as unread as it was, for its row under Not running. */
function keepUnread(pane: PaneState) {
  if (pane.kind === 'claude' && pane.started) markUnread(pane.sessionId, Boolean(pane.unread));
}

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
      unread: Boolean(v.pane.unread),
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
      unread: isMarkedUnread(a.sessionId),
      live: !a.ended,
      dot: busy ? 'running' : shippedOf(a.sessionId) && !a.ended ? shippedOf(a.sessionId)! : '',
      // Ended background sessions are done, stopped or failed; they stay openable, so they stay listed.
      chip: a.ended
        ? [`chip ${a.state === 'failed' ? 'exited' : ''}`, capitalize(a.state ?? 'ended')]
        : busy
          ? ['chip running', 'Busy']
          : shippedOf(a.sessionId)
            ? [`chip ${shippedOf(a.sessionId)}`, SHIPPED_TEXT[shippedOf(a.sessionId)!]]
            : ['chip idle', 'Idle'],
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
      unread: isMarkedUnread(s.sessionId),
      live: false,
      dot: '',
      chip: ['chip', archived ? 'Archived' : ''],
      tooltip: gone ? `${s.cwd}\nCannot be opened: ${gone}` : `${s.cwd}\nClick to open in Liszt (claude --resume)`,
      open: gone ? undefined : () => openSession(s.cwd, s.sessionId, s.title),
    });
  }
  // Every other session Claude Code still has a transcript of: ones that ran in a terminal and
  // ended, ones the Claude app no longer lists, Agent SDK runs and Liszt panes since closed.
  for (const t of transcriptSessions) {
    if (listed.has(t.sessionId) || isDeleted(t.sessionId)) continue;
    listed.add(t.sessionId);
    const folder = folderName(t.cwd);
    // The title it had in Liszt when it was archived from there.
    const title = state.sessionMarks[t.sessionId]?.title || t.title;
    const source = SOURCES[t.entrypoint ?? ''] ?? 'Claude Code';
    const archived = isArchived(t.sessionId);
    rows.push({
      group: 'stopped',
      sessionId: t.sessionId,
      cwd: t.cwd,
      title,
      project: projectFor(t.cwd)?.name ?? folder,
      where: `${folder} · active ${duration(Date.now() - t.lastActivityAt)} ago`,
      detail: t.gone ? `${source} · its folder no longer exists` : source,
      rank: NOT_RUNNING,
      time: t.lastActivityAt,
      pinned: false,
      archived,
      unread: isMarkedUnread(t.sessionId),
      live: false,
      dot: '',
      chip: ['chip', archived ? 'Archived' : ''],
      tooltip: t.gone ? `${t.cwd}\nCannot be opened: its folder no longer exists` : `${t.cwd}\nClick to open in Liszt (claude --resume)`,
      open: t.gone ? undefined : () => openSession(t.cwd, t.sessionId, title),
    });
  }
  // Sessions archived from Liszt that nothing lists any more, not even a transcript.
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
      unread: Boolean(m.unread),
      live: false,
      dot: '',
      chip: ['chip', m.archived ? 'Archived' : ''],
      tooltip: `${cwd}\nClick to open in Liszt (claude --resume)`,
      open: () => openSession(cwd, sessionId, title),
    });
  }
  // Outside Liszt an unread session shows it the way a pane does: once nothing is working in it.
  for (const r of rows) {
    if (r.view || !r.unread || r.dot === 'running') continue;
    r.dot = 'unread';
    r.rank = UNREAD_RANK;
    r.chip = ['chip unread', 'Unread'];
  }
  return rows;
}

function renderSessionRow(r: SessionRow): HTMLElement {
  const row = h('div', 'srow');
  if (r.view) row.classList.add(r.view.status);
  else row.classList.add('outside', ...(r.dot === 'running' ? ['running'] : []), ...(r.group === 'stopped' ? ['ended'] : []));
  if (r.dot === 'unread') row.classList.add('unread');
  if (!r.open) row.classList.add('gone');
  // The session open in front of you: the focused pane of the project on screen.
  if (r.view && r.view.pane.id === focusedPaneId && r.view.project.id === state.activeProjectId) row.classList.add('current');
  const pending = pendingSessions.get(r.sessionId);
  if (pending) row.classList.add('pending');
  const chip = h('span', r.chip[0], r.chip[1]);
  if (r.view) sessionChips.set(r.view.pane.id, chip);
  const more = iconEl(ICONS.more, 'srow-more');
  more.title = 'Mark unread, close, archive or delete';
  const top = h('div', 'srow-top');
  top.append(h('span', `dot ${r.dot}`));
  if (r.pinned) top.append(iconEl(ICONS.pin, 'srow-pin'));
  top.append(h('span', 'srow-title', r.title), chip, more);
  row.append(top, h('div', 'srow-where', r.where), h('div', 'srow-activity', pending ?? r.detail));
  if (selectedSessions.has(r.sessionId)) row.classList.add('selected');
  row.title = r.tooltip;
  // Shift-click would otherwise select the text of every row it passes over.
  row.addEventListener('mousedown', (e) => {
    if (e.shiftKey) e.preventDefault();
  });
  row.addEventListener('click', (e) => {
    if (more.contains(e.target as Node)) return void rowMenu(r, more);
    if (e.shiftKey) return selectRange(r.sessionId);
    if (e.metaKey) return toggleSelected(r.sessionId);
    clearSelection();
    r.open?.();
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void rowMenu(r, pointer(e));
  });
  return row;
}

/** The menu for a row, or for every selected row when it is one of several. */
function rowMenu(r: SessionRow, at: MenuAnchor) {
  if (selectedSessions.has(r.sessionId) && selectedSessions.size > 1) {
    const rows = sessionRows().filter((s) => selectedSessions.has(s.sessionId));
    return void sessionRowsMenu(rows, at);
  }
  clearSelection();
  void sessionRowMenu(r, at);
}

function toggleSelected(sessionId: string) {
  if (!selectedSessions.delete(sessionId)) selectedSessions.add(sessionId);
  selectionAnchor = sessionId;
  renderSessions();
}

/** Selects the rows from the anchor to this one, as Finder does. */
function selectRange(sessionId: string) {
  const from = shownSessionIds.indexOf(selectionAnchor ?? '');
  const to = shownSessionIds.indexOf(sessionId);
  selectedSessions.clear();
  if (from < 0) {
    selectedSessions.add(sessionId);
    selectionAnchor = sessionId;
  } else {
    for (const id of shownSessionIds.slice(Math.min(from, to), Math.max(from, to) + 1)) selectedSessions.add(id);
  }
  renderSessions();
}

function clearSelection() {
  if (!selectedSessions.size) return;
  selectedSessions.clear();
  selectionAnchor = undefined;
  renderSessions();
}

async function sessionRowsMenu(rows: SessionRow[], at: MenuAnchor) {
  const list = rows.filter((r) => !pendingSessions.has(r.sessionId));
  if (!list.length) return;
  const n = list.length;
  const unread = !list.some((r) => r.unread);
  const closable = list.filter((r) => r.view || r.live);
  const archived = !list.every((r) => r.archived);
  const choice = await showMenu(
    [
      { label: unread ? `Mark ${n} as Unread` : `Mark ${n} as Read`, id: 'unread', key: 'u' },
      'separator',
      { label: closable.length ? `Close ${closable.length} Sessions` : 'Close Sessions', id: 'close', key: 'c', enabled: closable.length > 0 },
      archived ? { label: `Archive ${n} Sessions`, id: 'archive', key: 'a' } : { label: `Unarchive ${n} Sessions`, id: 'unarchive', key: 'a' },
      'separator',
      { label: `Delete ${n} Sessions…`, id: 'delete', key: 'd', danger: true },
    ],
    at,
  );
  if (!choice) return;
  // Panes closed while the menu was open are left out.
  const still = list.filter((r) => !r.view || views.get(r.view.pane.id) === r.view);
  selectedSessions.clear();
  selectionAnchor = undefined;
  switch (choice) {
    case 'unread':
      for (const r of still) {
        if (r.view) setUnread(r.view, unread);
        else markUnread(r.sessionId, unread);
      }
      renderSessions();
      return save();
    case 'close':
      if (!confirmClose(still)) return renderSessions();
      await Promise.all(still.map((r) => closeSession(r, false)));
      return renderSessions();
    case 'archive':
      if (!confirmClose(still)) return renderSessions();
      await Promise.all(still.map((r) => archiveSession(r, true, false)));
      return renderSessions();
    case 'unarchive':
      await Promise.all(still.map((r) => archiveSession(r, false)));
      return renderSessions();
    case 'delete':
      return void deleteSessions(still);
  }
}

/** One question for closing several sessions, asked only when one of them works or runs outside Liszt. */
function confirmClose(rows: SessionRow[]): boolean {
  const busy = rows.filter((r) => (r.view ? isWorking(r.view) : r.live && r.dot === 'running'));
  const outside = rows.filter((r) => !r.view && r.live && !r.bgId);
  if (!busy.length && !outside.length) return true;
  const why = [
    busy.length ? `${busy.length} still working` : '',
    outside.length ? `${outside.length} running outside Liszt` : '',
  ].filter(Boolean);
  return confirm(`Close ${rows.length} sessions?\n\n${why.join(', ')}. Their conversations are kept and can be resumed.`);
}

async function sessionRowMenu(r: SessionRow, at: MenuAnchor) {
  if (pendingSessions.has(r.sessionId)) return;
  const canClose = Boolean(r.view) || r.live;
  const choice = await showMenu(
    [
      { label: r.view ? 'Show Session' : 'Open in Liszt', id: 'open', key: 'o', enabled: Boolean(r.open) },
      { label: r.unread ? 'Mark as Read' : 'Mark as Unread', id: 'unread', key: 'u' },
      'separator',
      { label: 'Close Session', id: 'close', key: 'c', enabled: canClose },
      r.archived ? { label: 'Unarchive', id: 'unarchive', key: 'a' } : { label: canClose ? 'Close and Archive' : 'Archive', id: 'archive', key: 'a' },
      'separator',
      { label: 'Delete Session…', id: 'delete', key: 'd', danger: true },
    ],
    at,
  );
  // Its pane may have been closed while the menu was open.
  if (r.view && views.get(r.view.pane.id) !== r.view) return;
  switch (choice) {
    case 'open':
      return r.open?.();
    case 'unread':
      if (r.view) return setUnread(r.view, !r.unread);
      markUnread(r.sessionId, !r.unread);
      renderSessions();
      return save();
    case 'close':
      return void closeSession(r);
    case 'archive':
      return void archiveSession(r, true);
    case 'unarchive':
      return void archiveSession(r, false);
    case 'delete':
      return void deleteSessions([r]);
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
 * `ask: false` skips the question when the caller already asked.
 */
async function closeSession(r: SessionRow, ask = true): Promise<boolean> {
  if (r.view) return closePane(r.view, { ask });
  if (!r.live) return true;
  const busy = r.dot === 'running';
  // Ending a process in another terminal or the Claude app is less expected than stopping an idle background session.
  if (ask && (busy || !r.bgId) && !confirm(`Close "${r.title}"?\n\nIt runs outside Liszt${busy ? ' and is still working' : ''}. Its conversation is kept and can be resumed.`)) return false;
  if (!(await sessionAction(r, 'Closing…', api.closeSession(r.sessionId, r.bgId)))) return false;
  // Until the next poll: an interactive session is no longer listed, a background one is stopped.
  agents = agents.flatMap((a) => (a.sessionId !== r.sessionId ? [a] : a.kind === 'background' ? [{ ...a, ended: true, state: 'stopped' }] : []));
  renderSessions();
  return true;
}

/** Archiving closes the session first; its title and folder are kept, as nothing may list it once it is closed. */
async function archiveSession(r: SessionRow, archived: boolean, ask = true) {
  if (archived && (r.view || r.live) && !(await closeSession(r, ask))) return;
  const mark = state.sessionMarks[r.sessionId];
  state.sessionMarks[r.sessionId] = archived
    ? { archived, unread: mark?.unread, title: r.title, cwd: r.cwd, at: Date.now() }
    : { ...mark, archived, at: mark?.at ?? Date.now() };
  renderSessions();
  save();
}

/** Deletes the sessions after one question, all at once. */
async function deleteSessions(rows: SessionRow[]) {
  const one = rows.length === 1 ? rows[0] : undefined;
  const bg = rows.filter((r) => r.bgId);
  const running = rows.filter((r) => r.view || r.live).length;
  // Liszt does not write to the app's files, so the app keeps its own entry.
  const inApp = rows.filter((r) => appSessions.some((s) => s.sessionId === r.sessionId)).length;
  const question = one
    ? `Delete "${one.title}"?\n\n${
        one.bgId ? `Claude Code removes the background session ${one.bgId} (claude rm), and its worktree when nothing would be lost. ` : ''
      }Its conversation is moved to the Trash and can no longer be resumed.${running ? '\n\nIt is closed first.' : ''}${
        inApp ? '\n\nThe Claude app keeps listing it until you delete it there.' : ''
      }`
    : `Delete ${rows.length} sessions?\n\n${
        bg.length ? `Claude Code removes ${bg.length} background sessions (claude rm), and their worktrees when nothing would be lost. ` : ''
      }Their conversations are moved to the Trash and can no longer be resumed.${running ? `\n\n${running} running are closed first.` : ''}${
        inApp ? `\n\nThe Claude app keeps listing ${inApp} of them until you delete them there.` : ''
      }`;
  if (!confirm(question)) return renderSessions();
  await Promise.all(
    rows.map(async (r) => {
      // Claude Code deletes a background session itself; stopping it as well would race with that.
      if (r.view) closePane(r.view, { ask: false, stop: false });
      if (!(await sessionAction(r, 'Deleting…', api.deleteSession(r.sessionId, r.bgId)))) return;
      state.sessionMarks[r.sessionId] = { deleted: true, at: Date.now() };
      agents = agents.filter((a) => a.sessionId !== r.sessionId);
      // A task would otherwise resume the deleted conversation; it starts a new one in its worktree instead.
      for (const project of state.projects) for (const task of project.tasks) if (task.sessionId === r.sessionId) task.sessionId = undefined;
    }),
  );
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
  const working = all.filter((r) => r.live && r.rank <= STATUS_ORDER.waiting).length;
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
  shownSessionIds = heads.flatMap(([key]) => groups.get(key)!.map((r) => r.sessionId));
  // A row a filter or search hides, or one that is gone, drops out of the selection.
  for (const id of selectedSessions) if (!shownSessionIds.includes(id)) selectedSessions.delete(id);
}

/** Opens a session in a new pane of its folder's project, adding the folder as a project if needed. */
function openSession(cwd: string, sessionId: string, title: string, bgId?: string) {
  // Opening it reads it; from here on its pane keeps whether it is unread.
  markUnread(sessionId, false);
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

function onTranscriptSessions(list: TranscriptSession[]) {
  transcriptSessions = list;
  renderSessions();
}

/**
 * A background session shows its listed status until a hook arrives: one Liszt did not start sends
 * none, and one that kept working while Liszt was closed sends the next only when something happens.
 * Sessions of projects not opened since launch run unattached and show it too. Once hooks drive the
 * status, the list only catches turns they miss.
 */
function syncAttached(v: PaneView) {
  if (v.status === 'exited') return;
  if (v.hooked) {
    catchTurn(v);
    return;
  }
  if (!(v.attached || (!v.spawned && v.pane.bgId))) return;
  const a = agents.find((x) => x.sessionId === v.pane.sessionId);
  if (!a) return;
  const status: Status = a.status === 'busy' ? 'running' : 'idle';
  if (status === v.status) return;
  if (status === 'idle' && (v.status === 'running' || v.pane.working)) finishTurn(v);
  else setStatus(v, status);
}

/** How long after its Stop hook runs Claude Code may still list the session busy. */
const STOP_SETTLE = 2000;

/**
 * A prompt typed while Claude works waits in Claude Code's queue and, unless Claude takes it in
 * between two tool calls, starts the next turn as soon as this one ends. Its UserPromptSubmit fires
 * when it is typed, though, before this turn's Stop, so no hook announces that next turn. Claude
 * Code lists the session busy meanwhile, and its first tool call shows it too. A turn caught only
 * from the list is taken back when the list shows the session idle before any hook comes.
 */
function catchTurn(v: PaneView) {
  const a = agents.find((x) => x.sessionId === v.pane.sessionId);
  if (!a) return;
  if (v.unannounced !== undefined && a.status === 'idle') {
    v.activity = v.unannounced;
    v.unannounced = undefined;
    setStatus(v, 'idle');
  } else if (v.status === 'idle' && a.status === 'busy' && agentsAsked - v.since > STOP_SETTLE) {
    const before = v.activity;
    startTurn(v);
    v.unannounced = before;
  }
}

/** Claude began a turn no UserPromptSubmit announced. */
function startTurn(v: PaneView) {
  v.actions = 0;
  v.activity = 'Working';
  setStatus(v, 'running');
  const task = taskOf(v);
  if (task?.status === 'review') setTaskStatus(v.project, task, 'doing');
}

function onAgents(list: AgentSession[], asked: number) {
  agents = list;
  agentsAsked = asked;
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

// --- Chat --------------------------------------------------------------------------------------

/** Starts a Claude pane's session again when it has ended; false when it would not start. */
async function ensureChat(v: PaneView): Promise<boolean> {
  if (!(v.spawned && v.status !== 'exited')) await spawn(v, continues(v.pane));
  return views.get(v.pane.id) === v && v.status !== 'exited';
}

/** Sends a message to a Claude pane's session, starting it again first when it has ended. */
function sendChat(v: PaneView, text: string, images: ChatImage[], uuid?: string) {
  setUnread(v, false);
  void ensureChat(v).then((ok) => ok && api.chatSend(v.pane.id, text, images, uuid));
}

/** The model menu under a chat's model button: the models the session offers, and the effort. */
async function pickModel(v: PaneView, anchor: HTMLElement) {
  const models = await api.chatModels(v.pane.id);
  if (!models.length || views.get(v.pane.id) !== v) return;
  const current = models.find((m) => m.value === v.model || m.resolvedModel === v.model);
  const levels = current?.supportedEffortLevels ?? ['low', 'medium', 'high', 'xhigh', 'max'];
  const entries: MenuEntry[] = models.map((m) => ({ label: m.displayName, id: `model:${m.value}`, checked: m === current }));
  if (current?.supportsEffort !== false)
    entries.push('separator', { label: 'Effort', submenu: levels.map((l) => ({ label: l, id: `effort:${l}`, checked: l === v.effort })) });
  const choice = await showMenu(entries, anchor);
  if (!choice || views.get(v.pane.id) !== v) return;
  const [kind, value] = [choice.slice(0, choice.indexOf(':')), choice.slice(choice.indexOf(':') + 1)];
  if (kind === 'model') {
    api.chatModel(v.pane.id, value);
    v.model = value;
  } else {
    api.chatEffort(v.pane.id, value as (typeof levels)[number]);
    v.effort = value;
  }
  v.chat?.setModel(models.find((m) => m.value === v.model)?.displayName ?? v.model ?? '', v.effort);
}

/**
 * Takes back the user's `index`th prompt: the session resumes from just before it, or starts over
 * when it was the first, and its text returns to the composer. Claude's changes to files can go
 * back too, from the checkpoints Claude Code keeps.
 */
async function rewindTo(v: PaneView, index: number, text: string) {
  const r = v.el.getBoundingClientRect();
  const choice = await showMenu(
    [
      { label: 'Rewind the Conversation', id: 'chat', key: 'c' },
      { label: 'Rewind the Conversation and the Code', id: 'code', key: 'b' },
    ],
    { x: r.left + r.width / 2 - 140, y: r.top + r.height / 2 },
  );
  if (!choice || views.get(v.pane.id) !== v) return;
  const res = await api.chatRewind(v.pane.id, v.pane.sessionId, v.pane.cwd ?? v.project.path, index, choice === 'code');
  if (views.get(v.pane.id) !== v) return;
  if (!res.ok) return v.chat?.error(`Could not rewind: ${res.error}`);
  api.kill(v.pane.id);
  v.pane.rewoundTo = res.resumeAt ?? undefined;
  save();
  await spawn(v, Boolean(res.resumeAt), undefined, res.resumeAt ?? undefined);
  if (views.get(v.pane.id) === v) v.chat?.setDraft(res.text || text);
}

function answerAsk(v: PaneView, id: string, a: ChatAnswer) {
  api.chatAnswer(v.pane.id, id, a);
  if (v.status === 'attention') {
    v.activity = a.allow ? 'Working' : 'Waiting for you';
    setStatus(v, 'running', true);
  }
}

/** Claude stopped to ask: a permission, a question or a plan to approve. */
function onChatAsk(id: string, ask: ChatAsk) {
  const v = views.get(id);
  if (!v?.chat) return;
  v.chat.ask(ask);
  v.activity =
    ask.tool === 'AskUserQuestion' ? 'Asking you a question' : ask.tool === 'ExitPlanMode' ? 'Has a plan for you to approve' : `Needs permission · ${ask.tool}`;
  setStatus(v, 'attention', true);
  notify(v, v.activity, 'attention');
}

/** A turn ended; a name asked for with Rename with Claude is in the session now. */
function onChatTurnEnd(v: PaneView) {
  if (!v.renaming) return;
  const asked = v.renaming;
  v.renaming = undefined;
  if (Date.now() - asked > RENAME_WAIT) return;
  void api.chatTitle(v.pane.sessionId, v.pane.cwd ?? v.project.path).then((title) => {
    if (!title || views.get(v.pane.id) !== v) return;
    v.pane.title = title;
    v.pane.customTitle = undefined;
    renderTitle(v);
    renderSessions();
    save();
  });
}

// --- Claude hooks ------------------------------------------------------------------------------

function notify(v: PaneView, body: string, kind: NotifyKind) {
  if (document.hasFocus() && state.activeProjectId === v.project.id && isVisible(v)) return;
  api.notify({ title: `${v.project.name} · ${displayTitle(v)}`, body, paneId: v.pane.id, kind });
}

function updateBadge() {
  const waiting = [...views.values()].filter((v) => v.status === 'attention').length;
  api.setBadge(waiting ? String(waiting) : '');
}

function onHook(ev: HookEvent) {
  const v = views.get(ev.paneId);
  if (!v) return;
  v.hooked = true;
  v.unannounced = undefined;
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
      // The new prompt makes the rewound conversation the transcript's latest.
      v.pane.rewoundTo = undefined;
      if (TASK_NOTIFICATION.test(ev.prompt ?? '')) {
        // A background task finished and Claude takes it up: the same piece of work goes on.
        v.activity = TASK_SUMMARY.exec(ev.prompt!)?.[1].trim() || 'Background task finished';
        setStatus(v, 'running', v.status === 'waiting');
        break;
      }
      v.actions = 0;
      // New work: what the last one shipped no longer describes the session.
      markShipped(v.pane.sessionId);
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
      // A tool ran, so a turn is under way even if nothing announced it (see catchTurn).
      if (v.status === 'idle') startTurn(v);
      v.actions += 1;
      v.activity = ev.detail ? `${ev.tool} · ${ev.detail}` : (ev.tool ?? 'Tool');
      // PostToolUse runs only when the command succeeded, so a push or merge here went out.
      const shipped = ev.command ? shippedBy(ev.command) : undefined;
      if (shipped && shippedOf(v.pane.sessionId) !== 'merged') markShipped(v.pane.sessionId, shipped);
      // The user answered a permission prompt and the tool ran.
      if (v.status === 'attention') setStatus(v, 'running', true);
      else renderSessions();
      break;
    case 'Notification':
      if (v.status === 'running') {
        v.activity = ev.message || 'Waiting for your input';
        setStatus(v, 'attention', true);
        notify(v, v.activity, 'attention');
      }
      break;
    case 'Stop':
      if ((v.status === 'running' || v.status === 'attention') && ev.tasks?.length) {
        // Not finished: Claude takes the work up again when its background tasks end.
        v.activity = waitingOn(ev.tasks);
        setStatus(v, 'waiting', true);
      } else if (v.status === 'running' || v.status === 'attention') {
        const took = duration(Date.now() - v.since);
        v.activity = `Finished in ${took}${v.actions ? ` · ${v.actions} tool ${v.actions === 1 ? 'call' : 'calls'}` : ''}`;
        finishTurn(v);
        notify(v, v.activity, 'done');
      }
      if (v.moveTo && !isWorking(v)) void moveSession(v);
      break;
  }

  const task = taskOf(v);
  if (task) {
    if (v.pane.started) task.sessionId = v.pane.sessionId;
    if (ev.event === 'UserPromptSubmit' && task.status === 'review') setTaskStatus(v.project, task, 'doing');
    if (ev.event === 'Stop' && !ev.tasks?.length && task.status === 'doing') setTaskStatus(v.project, task, 'review');
  }
  v.chat?.setActivity(v.status === 'running' ? v.activity : '');
  save();
}

/** The prompt Claude Code submits itself when a background task ends, and the line that says how. */
const TASK_NOTIFICATION = /^\s*<task-notification>/;
const TASK_SUMMARY = /<summary>([^<]*)<\/summary>/;

/** What a session waits on, for its activity line. */
function waitingOn(tasks: BackgroundTask[]): string {
  if (tasks.length > 1) return `Waiting on ${tasks.length} background tasks`;
  return `Waiting on ${tasks[0].type === 'shell' ? 'shell' : 'background task'} · ${tasks[0].label}`;
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
    if (v.term) v.term.options.fontSize = state.fontSize;
    v.chat?.el.style.setProperty('--chat-size', `${state.fontSize + 1}px`);
    scheduleFit(v);
  }
  save();
}

// The first wheel event after a pause is one step, so each notch of a slowly turned mouse wheel
// counts however small macOS makes its delta. A trackpad swipe or a fast spin sends a stream of
// events, and those add up until a step's worth has gathered.
const WHEEL_STEP = 40;
const WHEEL_PAUSE = 150;
let wheelZoom = 0;
let lastWheel = -Infinity;

function zoomByWheel(e: WheelEvent) {
  const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
  const paused = e.timeStamp - lastWheel > WHEEL_PAUSE;
  lastWheel = e.timeStamp;
  if (!delta) return;
  if (paused) {
    wheelZoom = 0;
    // Scrolling up makes the text bigger.
    setFontSize(state.fontSize - Math.sign(delta));
    return;
  }
  wheelZoom += delta;
  const steps = Math.trunc(wheelZoom / WHEEL_STEP);
  if (!steps) return;
  wheelZoom -= steps * WHEEL_STEP;
  // Scrolling up makes the text bigger.
  setFontSize(state.fontSize - steps);
}

// --- Wiring ------------------------------------------------------------------------------------

function onMenu(command: string) {
  // A shortcut acts on the app as it is, not on what an open menu was about.
  closeMenu();
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
    case 'new-project':
      return void newProject();
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
    case 'toggle-view':
      if (focused) switchView(focused);
      return;
  }
}

api.onData((id, data) => views.get(id)?.term?.write(data));
api.onExit((id, code) => {
  const v = views.get(id);
  if (!v) return;
  v.exitCode = code;
  v.activity = code ? `Exited with code ${code}` : 'Exited';
  setStatus(v, 'exited');
  if (!inTerminal(v)) v.chat?.exited(code ? `The session ended with code ${code}.` : 'The session ended.');
  else v.term?.write(`\r\n\x1b[90m[process exited${code ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
  const task = taskOf(v);
  if (task?.status === 'doing') setTaskStatus(v.project, task, 'review');
});
api.onChatEvent((id, m) => {
  const v = views.get(id);
  if (!v?.chat) return;
  if (m.type === 'system' && m.subtype === 'init' && typeof m.model === 'string') v.model = m.model;
  v.chat.event(m);
  if (m.type === 'result') onChatTurnEnd(v);
});
api.onChatAsk(onChatAsk);
api.onBackground((id, bgId) => {
  const v = views.get(id);
  if (!v) return;
  v.pane.bgId = bgId;
  save();
  renderSessions();
});
api.onChatUnask((id, askId) => {
  const v = views.get(id);
  v?.chat?.unask(askId);
  if (v?.status === 'attention') setStatus(v, 'running', true);
});
api.onChatError((id, text) => views.get(id)?.chat?.error(text));
api.onHook(onHook);
api.onAgents(onAgents);
api.onAppSessions(onAppSessions);
api.onTranscriptSessions(onTranscriptSessions);
api.onMoveRequest(onMoveRequest);
api.onMenu(onMenu);
api.onFocusPane((id) => {
  const v = views.get(id);
  if (v) revealPane(v);
});

for (const [id, svg] of [
  ['new-project', ICONS.newProject],
  ['new-claude', ICONS.claude],
  ['new-shell', ICONS.shell],
  ['toggle-sidebar', ICONS.branch],
  ['toggle-sessions', ICONS.sessions],
  ['toggle-tasks', ICONS.tasks],
] as const) {
  byId(id).innerHTML = svg;
}
byId('add-project').innerHTML = ICONS.plus;
byId('new-project').addEventListener('click', () => void newProject());
// ⌃N, as the menu shows it: taken before the terminal, where it would step through the prompt history.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.code !== 'KeyN' || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    void newProject();
  },
  true,
);
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
  } else if (e.key === 'Escape' && selectedSessions.size) {
    e.preventDefault();
    clearSelection();
  } else if (e.key === 'Escape' && !sessionSearch.value && focusedPaneId) {
    e.preventDefault();
    focusPane(focusedPaneId);
  }
});
apOffBtn.addEventListener('click', () => setAutopilot(false));
apOnBtn.addEventListener('click', () => setAutopilot(true));
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
    if (v.status !== 'running' && v.status !== 'waiting') continue;
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
  // Older states have no groups.
  state.groups ??= [];
  normalizeGroups();
  // Older states kept the Changes panel as a boolean.
  const side: unknown = state.sidebar;
  setSidebar(side === true || side === 'changes' ? 'changes' : side === 'sessions' ? 'sessions' : null);
  if (!(state.sessionFilter in FILTERS)) state.sessionFilter = 'active';
  if (!(state.sessionSort in SORTS)) state.sessionSort = 'status';
  sessionFilter.set(state.sessionFilter);
  sessionSort.set(state.sessionSort);
  setTasksPanel(state.tasksPanel);
  for (const project of state.projects) {
    for (const pane of project.panes) createView(project, pane);
    renderLayout(project);
    if (!project.icon || (!project.icon.custom && !project.icon.image)) void detectIcon(project);
  }
  const active = activeProject() ?? state.projects[0] ?? null;
  activateProject(active?.id ?? null);
  // Chats that kept running in the session host while Liszt was closed are attached to again in
  // every project, so their status shows and their questions come back.
  const live = new Set((await api.chatLive()).map((x) => x.id));
  for (const v of views.values()) if (live.has(v.pane.id) && !v.spawned && !inTerminal(v)) void spawn(v, true);
  // Tasks in progress keep running in background projects too.
  for (const project of state.projects) {
    for (const task of project.tasks) {
      const v = task.status === 'doing' && task.paneId ? views.get(task.paneId) : undefined;
      if (v && !v.spawned) void spawn(v, continues(v.pane));
    }
    void pump(project);
  }
  renderSessions();
}

void boot();
