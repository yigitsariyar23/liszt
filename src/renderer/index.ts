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
  HostTerm,
  LayoutNode,
  NotifyKind,
  PaneKind,
  PaneState,
  ProjectGroup,
  ProjectState,
  RepoOf,
  SessionFilter,
  SessionMark,
  SessionSort,
  Settings,
  SidebarView,
  TaskState,
  TaskStatus,
  TranscriptSession,
} from '../shared/types';
import { ChatView, type PromptRef } from './chat';
import { h, iconEl } from './dom';
import { ICONS, KIND_GLYPH } from './icons';
import { leaf, panesIn, removePane, replacePane, splitPane, type Side } from './layout';
import { ask as askDialog, tell } from './dialog';
import { undoNewest, undoToast } from './toast';
import { hoverTip } from './tip';
import { closeMenu, dropdown, showMenu, type MenuAnchor, type MenuEntry } from './menu';
import { openSettings } from './settings';
import { mediaLinks, openMedia, opensInViewer } from './viewer';
import { pathLinks } from './paths';
import { isLocalTarget } from '../shared/media';
import { matchesAccelerator, shortcutFor, shortcutLabel } from '../shared/shortcuts';

declare global {
  interface Window {
    liszt: LisztApi;
  }
}

const api = window.liszt;

/**
 * `waiting`: Claude ended its turn while background tasks it started still run; it goes on when they finish.
 * `listening`: the turn is over and only listeners are left (a monitor or a subscription, e.g. an
 * artifact watch). They never finish on their own, so the session is done — it may wake on an event.
 */
type Status = 'starting' | 'idle' | 'running' | 'attention' | 'waiting' | 'listening' | 'exited';

/** Claude has work under way, whether it is acting, asking or waiting on its background tasks. */
const isWorking = (v: PaneView) => v.status === 'running' || v.status === 'attention' || v.status === 'waiting';
/** Done with its turn: idle, or idle with listeners still open. */
const isAtRest = (v: PaneView) => v.status === 'idle' || v.status === 'listening';

/** Background work Claude waits on, apart from listeners, which never end by themselves. */
const LISTENER_TYPES = new Set(['monitor']);
const isListener = (t: BackgroundTask) => LISTENER_TYPES.has(t.type);
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
  /** While `listening`: what still listens, for the chip's tooltip. */
  listening?: string;
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
  /** A command the shell runs once it is up, typed in as if by hand. */
  run?: string;
  runTimer?: number;
  /** A draft the chat had, pasted at Claude Code's prompt once the terminal has drawn it. */
  typeIn?: string;
  /** Asked to switch between chat and terminal while working; it switches when the turn ends. */
  switchPending?: boolean;
  /** The Rewind and Edit buttons shown over the terminal prompt the pointer is on. */
  promptActions?: HTMLElement;
  /** A rewind to just after a reply: the prompt Claude Code puts back in its input is cleared. */
  rewindClear?: { text: string; lines: number; until: number; timer?: number };
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
  /** Name a new Claude session starts with, as `claude agents` lists it. */
  name?: string;
  /** A command a new shell runs once it is up. */
  run?: string;
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
/** The shortcuts chosen in Settings, by command id; loaded at boot and after each change. */
let shortcuts: Record<string, string> = {};
/** How a new Claude session opens, as chosen in Settings. */
let claudeView: Settings['claudeView'] = 'terminal';
/** A command's shortcut as the menu shows it, for hints in titles and buttons. */
const keyHint = (id: string) => shortcutLabel(shortcutFor(id, shortcuts));
/** ` (⌘T)` after a hint's text, or nothing when the command has no shortcut. */
const withKey = (text: string, id: string) => (keyHint(id) ? `${text} (${keyHint(id)})` : text);
let focusedPaneId: string | null = null;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const tabsEl = byId('tabs');
const projectTreeEl = byId('project-tree');
/** The hover card of a project tree session; see showTreeCard. */
const treeCard = h('div', 'tree-card');
document.body.append(treeCard);
let treeCardKey: string | undefined;
let treeCardTimer: ReturnType<typeof setTimeout> | undefined;
const projectsCountEl = byId('projects-count');
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
const jobListEl = byId('job-list');
const jobsCountEl = byId('jobs-count');
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
const FILTER_OPTIONS: Array<[SessionFilter, string]> = [
  ['active', 'Active'],
  ['liszt', 'In Liszt'],
  ['running', 'Running'],
  ['unread', 'Unread'],
  ['pinned', 'Pinned'],
  ['archived', 'Archived'],
  ['all', 'All'],
];
const SORT_OPTIONS: Array<[SessionSort, string]> = [
  ['status', 'Status'],
  ['recent', 'Recent'],
  ['name', 'Name'],
  ['project', 'Project'],
];
// The Sessions panel and the project tree share one Show and one Sort choice.
const setSessionFilter = (value: SessionFilter) => {
  state.sessionFilter = value;
  sessionFilter.set(value);
  treeFilter.set(value);
  renderSessions();
  save();
};
const setSessionSort = (value: SessionSort) => {
  state.sessionSort = value;
  sessionSort.set(value);
  treeSort.set(value);
  renderSessions();
  save();
};
const sessionFilter = dropdown<SessionFilter>(byId('session-filter'), FILTER_OPTIONS, setSessionFilter);
const sessionSort = dropdown<SessionSort>(byId('session-sort'), SORT_OPTIONS, setSessionSort);
const treeSearch = byId<HTMLInputElement>('tree-search');
const treeFilter = dropdown<SessionFilter>(byId('tree-filter'), FILTER_OPTIONS, setSessionFilter);
const treeSort = dropdown<SessionSort>(byId('tree-sort'), SORT_OPTIONS, setSessionSort);

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

const KEYMAP: Array<[(e: KeyboardEvent, v: PaneView) => boolean, string]> = [
  [(e) => e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey, '\x1b\r'], // newline in Claude's prompt
  // Cmd+Z or Ctrl+Z undoes in Claude's prompt, where undo is Ctrl+_ and Ctrl+Z would only suspend
  // claude. A shell keeps Ctrl+Z for job control, and its line editor may not undo with Ctrl+_.
  [(e, v) => v.pane.kind === 'claude' && e.code === 'KeyZ' && !e.shiftKey && !e.altKey && e.metaKey !== e.ctrlKey, '\x1f'],
  [(e) => e.key === 'ArrowLeft' && e.metaKey, '\x01'],
  [(e) => e.key === 'ArrowRight' && e.metaKey, '\x05'],
  [(e) => e.key === 'Backspace' && e.metaKey, '\x15'],
  [(e) => e.key === 'ArrowLeft' && e.altKey && !e.metaKey, '\x1bb'],
  [(e) => e.key === 'ArrowRight' && e.altKey && !e.metaKey, '\x1bf'],
  // Option+Up and Option+Down go to the start and end of the line in Claude's prompt, as Cmd+Left and Cmd+Right do.
  [(e, v) => v.pane.kind === 'claude' && e.key === 'ArrowUp' && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey, '\x01'],
  [(e, v) => v.pane.kind === 'claude' && e.key === 'ArrowDown' && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey, '\x05'],
  [(e) => e.key === 'Backspace' && e.altKey && !e.metaKey, '\x17'],
];

function handleKey(v: PaneView, e: KeyboardEvent): boolean {
  const hit = KEYMAP.find(([match]) => match(e, v));
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
  closeBtn.title = withKey('Close session', 'close-pane');
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
      cancelBash: () => api.chatBashCancel(pane.id),
      toTerminal: (command) => void addPane('shell', v.project, { cwd: v.pane.cwd, split: 'right', run: command }),
      files: () => api.chatFiles(pane.cwd ?? project.path),
      pickModel: (anchor) => void pickModel(v, anchor),
      stopTask: (taskId) => api.chatStopTask(pane.id, taskId),
      rewind: (prompt, edit) => void rewindTo(v, prompt, edit),
      answer: (id, a) => answerAsk(v, id, a),
      interrupt: () => api.chatInterrupt(pane.id),
      setMode: (mode) => api.chatMode(pane.id, mode),
      openLink: (target, e) => openLink(target, v, e),
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

/** The folder a pane's session runs in; a relative path it prints is taken from here. */
const cwdOf = (v: PaneView) => v.pane.cwd ?? v.project.path;

/**
 * A link clicked in a pane: an image or video shows in the viewer, a web page in the browser, any
 * other local path in Finder. Cmd- or Shift-click opens a local path, media too, in VS Code,
 * in a window on the project's folder.
 */
function openLink(uri: string, v: PaneView, e?: MouseEvent) {
  const cwd = cwdOf(v);
  const local = isLocalTarget(uri);
  if (local && (e?.metaKey || e?.shiftKey)) api.openLocation(uri, cwd, 'code', v.project.path);
  else if (opensInViewer(uri)) openMedia(api, uri, cwd);
  else if (local) api.openLocation(uri, cwd, 'finder');
  else api.openExternal(uri);
}

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
    // OSC 8 links a program prints: images and videos open in the viewer, web pages in the browser.
    linkHandler: { activate: (e, uri) => openLink(uri, v, e), allowNonHttpProtocols: true },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri, v)));
  term.registerLinkProvider(mediaLinks(term, (e, target) => openLink(target, v, e)));
  term.registerLinkProvider(pathLinks(term, api, () => cwdOf(v), (e, target) => openLink(target, v, e)));
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
  if (pane.kind === 'claude') attachPromptActions(v, term);

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
    const to = terminal ? 'chat' : 'terminal';
    btn.innerHTML = terminal ? ICONS.chat : ICONS.shell;
    btn.classList.toggle('pending', Boolean(v.switchPending));
    btn.title = v.switchPending
      ? `Goes on in the ${to} once this turn ends${keyHint('toggle-view') ? ` (${keyHint('toggle-view')} to stay)` : ''}`
      : withKey(terminal ? 'Show as chat' : 'Show in the terminal', 'toggle-view');
  }
  if (terminal) scheduleFit(v);
}

/**
 * Moves a Claude session between the chat and Claude Code's terminal UI. Only one of them can run
 * the session, so the one showing stops and the other resumes the same conversation. A turn under
 * way is not cut short: the switch waits for it to end, and asking again calls it off.
 */
function switchView(v: PaneView, handover = false) {
  if (v.pane.kind !== 'claude') return;
  if (isWorking(v)) {
    v.switchPending = !v.switchPending || undefined;
    paintView(v);
    return;
  }
  v.switchPending = undefined;
  // What is typed and not sent yet goes along.
  const draft = v.pane.terminal ? terminalDraft(v) : v.chat?.draftText;
  v.typeIn = undefined;
  v.pane.terminal = !v.pane.terminal || undefined;
  // The terminal gets a background session of its own, resumed from where the chat left off; one
  // the pane had before stopped when it went to the chat.
  if (v.pane.terminal) v.pane.bgId = undefined;
  save();
  if (v.pane.terminal) ensureTerminal(v).reset();
  paintView(v);
  if (v.spawned) {
    api.kill(v.pane.id);
    void spawn(v, continues(v.pane), undefined, undefined, handover);
  }
  // A switch made when the turn ended leaves the keyboard where it is.
  const focus = !handover || focusedPaneId === v.pane.id;
  if (v.pane.terminal) v.typeIn = draft || undefined;
  else if (draft != null) v.chat?.setDraft(draft, focus);
  if (focus) focusView(v);
}

/** The rules above and below Claude Code's prompt. */
const PROMPT_RULE = /^─+$/;
/** The prompt's first line starts with its sign, `❯` or `!` in bash mode, and a no-break space. */
const PROMPT_SIGN = /^[❯>!](?:[  ]|$)/;

/**
 * What is typed at Claude Code's prompt in a pane's terminal, read off the screen: the lines between
 * the two rules around the prompt. Its placeholder is dim and not part of it. Claude Code wraps long
 * lines at word breaks, so a line ends a line of the draft only where the next word would have fit
 * on it. Null when no prompt shows.
 */
function terminalDraft(v: PaneView): string | null {
  const term = v.term;
  if (!term) return null;
  const buf = term.buffer.active;
  const text = (y: number) => {
    const line = buf.getLine(y);
    let s = '';
    for (let x = 0; line && x < term.cols; x++) {
      const cell = line.getCell(x);
      // The second half of a wide character has no width of its own.
      if (cell && cell.getWidth() && !cell.isDim()) s += cell.getChars() || ' ';
    }
    return s.trimEnd();
  };
  const top = buf.baseY;
  for (let end = top + term.rows - 1; end > top; end--) {
    if (!PROMPT_RULE.test(text(end))) continue;
    let start = end - 1;
    while (start >= top && !PROMPT_RULE.test(text(start))) start--;
    if (start < top) return null;
    const lines: string[] = [];
    for (let y = start + 1; y < end; y++) lines.push(text(y));
    // Two rules around something else, a table say; the prompt is further up.
    if (!lines.length || !PROMPT_SIGN.test(lines[0])) {
      end = start + 1;
      continue;
    }
    const bash = lines[0].startsWith('!');
    const body = lines.map((l) => l.slice(2));
    // The sign takes two columns and the right edge two more.
    const width = term.cols - 4;
    let draft = body[0];
    for (let i = 1; i < body.length; i++) {
      const prev = body[i - 1];
      const word = body[i].split(' ')[0].length;
      // A full line broke a word; one the next word would not fit on wrapped at a space. A word as long
      // as a line runs on past it, and fits on none.
      const wrapped = word < width && prev.length + 1 + word > width;
      draft += prev.length >= width ? body[i] : wrapped ? ` ${body[i]}` : `\n${body[i]}`;
    }
    return bash ? `!${draft}` : draft;
  }
  return null;
}

// --- Rewinding in the terminal ---------------------------------------------------------------------
//
// Claude Code draws each prompt of the conversation as a `❯` line on a shaded background. Over the
// one the pointer is on, Rewind and Edit do what they do in the chat, through Claude Code's own
// rewind picker (Esc Esc): the prompt is picked in it, and Claude Code asks what to restore.

/** A line of the terminal's buffer as text, and whether it starts on a shaded background. */
function bufferLine(term: Terminal, y: number): { text: string; shaded: boolean } {
  const line = term.buffer.active.getLine(y);
  if (!line) return { text: '', shaded: false };
  const first = line.getCell(0);
  return { text: line.translateToString(true), shaded: Boolean(first && !first.isBgDefault()) };
}

/** The first line of the conversation prompt that line `y` is part of, or -1. */
function promptStart(term: Terminal, y: number): number {
  for (let at = y, n = 0; at >= 0 && n < 60; at--, n++) {
    const line = bufferLine(term, at);
    if (!line.shaded) return -1;
    if (line.text.startsWith('❯')) return at;
  }
  return -1;
}

/** The first lines of the conversation prompts from line `from` down. */
function promptsBelow(term: Terminal, from: number): number[] {
  const starts: number[] = [];
  const buf = term.buffer.active;
  for (let y = from; y < buf.length; y++) {
    const line = bufferLine(term, y);
    if (line.shaded && line.text.startsWith('❯')) starts.push(y);
  }
  return starts;
}

/** How many lines the conversation prompt starting at line `y` takes. */
function promptLines(term: Terminal, y: number): number {
  let n = 1;
  while (n < 60 && bufferLine(term, y + n).shaded && !bufferLine(term, y + n).text.startsWith('❯')) n++;
  return n;
}

/** The first line of Claude Code's input on the screen, without its `❯`: unlike the conversation's prompts it is not shaded. */
function inputHead(term: Terminal): string | null {
  const buf = term.buffer.active;
  for (let y = buf.baseY + term.rows - 1; y >= buf.baseY; y--) {
    const line = bufferLine(term, y);
    if (!line.shaded && /^❯(?:[ \u00a0]|$)/.test(line.text)) return line.text.slice(1).trim();
  }
  return null;
}

/** A prompt's first line as Claude Code shows it, without the `❯`. */
const promptHead = (term: Terminal, y: number) => bufferLine(term, y).text.slice(1).trim();

function attachPromptActions(v: PaneView, term: Terminal) {
  const bar = h('div', 'term-prompt-actions');
  const rewind = h('button', undefined, 'Rewind');
  rewind.title = 'Rewind the conversation to just after this reply; what came later is forgotten';
  const edit = h('button', undefined, 'Edit');
  edit.title = 'Edit this prompt: the conversation goes back to just before it';
  bar.append(rewind, edit);
  bar.hidden = true;
  v.termHost.append(bar);
  v.promptActions = bar;
  let start = -1;
  const hide = () => {
    bar.hidden = true;
    start = -1;
  };
  v.termHost.addEventListener('mousemove', (e) => {
    if (bar.contains(e.target as Node)) return;
    const screen = v.termHost.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || !v.pane.started || !inTerminal(v)) return hide();
    const r = screen.getBoundingClientRect();
    const rowH = r.height / term.rows;
    const row = Math.floor((e.clientY - r.top) / rowH);
    if (row < 0 || row >= term.rows || e.clientX < r.left || e.clientX > r.right) return hide();
    const at = promptStart(term, term.buffer.active.viewportY + row);
    if (at < 0) return hide();
    start = at;
    rewind.hidden = promptsBelow(term, at + 1).length === 0;
    const host = v.termHost.getBoundingClientRect();
    const top = Math.max(0, at - term.buffer.active.viewportY) * rowH;
    bar.style.top = `${r.top - host.top + top}px`;
    bar.style.right = `${host.right - r.right + 4}px`;
    bar.style.height = `${rowH}px`;
    bar.hidden = false;
  });
  v.termHost.addEventListener('mouseleave', hide);
  term.onScroll(hide);
  const go = (e: MouseEvent, after: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const at = start;
    hide();
    if (at >= 0) void rewindTerminal(v, term, at, after);
  };
  // Pressed before xterm sees the click, so it starts no selection and keeps the focus where it is.
  for (const b of [rewind, edit]) b.addEventListener('mousedown', (e) => e.preventDefault());
  rewind.addEventListener('click', (e) => go(e, true));
  edit.addEventListener('click', (e) => go(e, false));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The rows of Claude Code's rewind picker on the screen, from its title down; null when it is not open. */
function rewindPicker(term: Terminal): string[] | null {
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) rows.push(bufferLine(term, y).text);
  const title = rows.findIndex((t) => t.trim() === 'Rewind');
  if (title < 0 || !rows.slice(title).some((t) => /Enter to continue/.test(t))) return null;
  return rows.slice(title);
}

/** Whether the picker's chosen row, cut short with `…` when long, shows the prompt whose first line is `head`. */
function pickedIs(rows: string[], head: string): boolean {
  const picked = rows.map((t) => /^\s+❯\s+(.*)$/.exec(t)?.[1]).find((t) => t !== undefined);
  if (picked === undefined) return false;
  const a = picked.replace(/…$/, '').trim();
  const n = Math.min(a.length, head.length);
  return n > 0 && a.slice(0, n) === head.slice(0, n);
}

/**
 * Rewinds a session in the terminal to just before the prompt drawn at line `at`, or with `after`
 * to just after its reply, i.e. before the next prompt. Claude Code's rewind picker lists the
 * prompts with the newest last, so the one wanted is as many rows up as there are prompts from it
 * down. It is chosen there if it is the one the picker shows, and Claude Code then asks what to
 * restore; otherwise the picker is left open to choose by hand.
 */
async function rewindTerminal(v: PaneView, term: Terminal, at: number, after: boolean) {
  const prompts = promptsBelow(term, at);
  const target = after ? prompts[1] : prompts[0];
  if (target === undefined) return;
  const head = promptHead(term, target);
  const ups = prompts.length - prompts.indexOf(target);
  const id = v.pane.id;
  // Esc stops a turn under way; the picker opens at the prompt.
  if (!(await stopTurn(v, () => api.write(id, '\x1b')))) return;
  term.focus();
  let rows: string[] | null = null;
  // A first Esc Esc clears what is typed at the prompt instead.
  for (let tries = 0; tries < 3 && !rows; tries++) {
    api.write(id, '\x1b');
    await sleep(200);
    api.write(id, '\x1b');
    for (let waited = 0; waited < 2000 && !(rows = rewindPicker(term)); waited += 100) await sleep(100);
  }
  if (!rows || views.get(id) !== v) return;
  for (let i = 0; i < ups; i++) {
    api.write(id, '\x1b[A');
    await sleep(40);
  }
  await sleep(250);
  rows = rewindPicker(term);
  if (!rows || !pickedIs(rows, head)) return;
  // Rewound to just before the next prompt, Claude Code puts that prompt back in its input.
  if (after) v.rewindClear = { text: head, lines: promptLines(term, target), until: Date.now() + 60_000 };
  api.write(id, '\r');
}

/**
 * After a rewind to just after a reply, clears the prompt Claude Code put back in its input, once
 * the picker has closed. Choosing not to restore the conversation leaves the input empty, and the
 * wait for it runs out.
 */
function clearRewoundPrompt(v: PaneView) {
  const want = v.rewindClear;
  if (!want || !v.term) return;
  if (Date.now() > want.until) return void (v.rewindClear = undefined);
  // The picker, or Claude Code's question after it, is still up.
  if (rewindPicker(v.term)) return;
  // Empty, the input may not have been filled yet; until it is, or the wait runs out.
  const input = inputHead(v.term);
  if (!input) return;
  v.rewindClear = undefined;
  if (!input.startsWith(want.text.slice(0, 20))) return;
  // ⌃U deletes back to the start of a line, ⌫ joins it to the line before.
  api.write(v.pane.id, '\x15\x7f'.repeat(want.lines) + '\x15');
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

/** A new chat's card: where it runs at once, and its model and plan usage once the session answers. */
async function fillWelcome(v: PaneView) {
  const chat = v.chat;
  if (!chat) return;
  const cwd = v.pane.cwd ?? v.project.path;
  const base = { project: v.project.name, folder: cwd.replace(/^\/Users\/[^/]+/, '~'), branch: v.pane.branch };
  chat.setWelcome({ ...base, icon: projectIcon(v.project) });
  const [git, info] = await Promise.all([api.gitInfo(cwd).catch(() => null), api.chatInfo(v.pane.id).catch(() => null)]);
  if (views.get(v.pane.id) !== v || v.chat !== chat) return;
  chat.setWelcome({ ...base, branch: git?.branch ?? base.branch, icon: projectIcon(v.project), info });
}

/** `handover`: the turn the other side ran has just ended, and its background session may still be settling. */
async function spawn(v: PaneView, resume: boolean, prompt?: string, resumeAt?: string, handover = false) {
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
  // A switch waiting on a turn that a restart or a switch ended is off.
  if (v.switchPending) {
    v.switchPending = undefined;
    paintView(v);
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
    name: v.pane.name,
    terminal: v.pane.kind === 'claude' && inTerminal(v),
    resumeAt,
    handover,
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
    if (chat && !res.resumed) void fillWelcome(v);
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
    case 'listening':
      return isUnread(v) ? 'Unread' : 'Listening';
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
  // Says what it waits on, or what still listens.
  el.title = v.status === 'waiting' ? v.activity : v.status === 'listening' ? v.listening ?? '' : '';
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
const isUnread = (v: PaneView) => Boolean(v.pane.unread) && (isAtRest(v) || !v.spawned);

const dotClass = (v: PaneView) => {
  if (isUnread(v)) return 'unread';
  if (['running', 'attention', 'waiting', 'listening', 'exited'].includes(v.status)) return v.status;
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

/**
 * Claude ended its turn; the reply stays unread unless the user is watching the session. Listeners
 * it left open (monitors, subscriptions) keep it `listening` rather than idle.
 */
function finishTurn(v: PaneView, listeners: BackgroundTask[] = []) {
  if (!watching(v)) v.pane.unread = true;
  v.listening = listeners.length ? listeningTo(listeners) : undefined;
  setStatus(v, listeners.length ? 'listening' : 'idle');
  // A switch asked for during the turn, made after the hook that ended it is handled. A message
  // queued in the chat starts the next turn, and the switch waits for that one.
  if (v.switchPending && !(v.chat?.hasQueued && !inTerminal(v)))
    setTimeout(() => views.get(v.pane.id) === v && v.switchPending && !isWorking(v) && switchView(v, true));
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
const atPrompt = (v: PaneView) => v.pane.kind === 'claude' && v.pane.started && v.spawned && (isAtRest(v) || v.status === 'waiting');

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
  if (!box) return void tell(`"${displayTitle(v)}" is not at its prompt. Close what is open in it, then ask again.`);
  // Ctrl+S keeps one draft aside, so it would drop the one already there.
  if (box.draft && box.stashed) return void tell(`"${displayTitle(v)}" has a draft in its prompt and another stashed with Ctrl+S. Send or clear the draft, then ask again.`);
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
  if (v.pane.kind === 'claude') {
    const label = v.pane.terminal ? 'Show as Chat' : 'Show in Terminal';
    entries.push({ label: v.switchPending ? `Stay in the ${v.pane.terminal ? 'Terminal' : 'Chat'}` : isWorking(v) ? `${label} When Done` : label, id: 'toggle-view', key: 'e' });
  }
  if (v.pane.kind === 'claude') entries.push({ label: 'Copy Session ID', id: 'copy-id', key: 'i', enabled: v.pane.started });
  entries.push('separator', { label: 'Close Session', id: 'close', key: 'c' }, { label: 'Close Other Sessions', id: 'close-others', key: 'o', enabled: project.panes.length > 1 });
  // A shell has no conversation to delete; a Claude session that never started has nothing kept yet.
  if (v.pane.kind === 'claude') entries.push('separator', { label: 'Delete Session…', id: 'delete', key: 'd', danger: true, enabled: v.pane.started });
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
        if (other && other !== v) void closePane(other);
      }
      return;
    case 'delete': {
      const row = sessionRows().find((r) => r.view === v);
      return void (row && deleteSessions([row]));
    }
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
  const hinted = (text: string, id: string) => (keyHint(id) ? `${text} · ${keyHint(id)}` : text);
  const claudeBtn = h('button', 'secondary', hinted('New Claude session', 'new-claude'));
  const shellBtn = h('button', 'secondary', hinted('New shell', 'new-shell'));
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
    name: opts.name,
    terminal: (kind === 'claude' && claudeView === 'terminal') || undefined,
  };
  // New tabs open next to the focused one, like a browser; task sessions line up at the end.
  const at = opts.taskId ? -1 : project.panes.findIndex((p) => p.id === project.activePaneId);
  project.panes.splice(at < 0 ? project.panes.length : at + 1, 0, pane);
  const v = createView(project, pane);
  v.run = opts.run;

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
async function closePane(v: PaneView, { ask = true, stop = true } = {}): Promise<boolean> {
  // With `ask: false` nothing is awaited, so the pane is gone by the time the call returns.
  if (ask && isWorking(v)) {
    if (!(await askDialog(`"${displayTitle(v)}" is still working. Close it?`, { ok: 'Close' }))) return false;
    // Closed some other way while the question was open.
    if (views.get(v.pane.id) !== v) return true;
  }
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
    close.title = withKey('Close session', 'close-pane');
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
  add.title = withKey('New Claude session', 'new-claude') + (keyHint('split-right') ? ` · split with ${keyHint('split-right')}` : '');
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

// Pinned projects are grouped by the project folder they sit in, one group per folder chosen in
// Settings, leading the row in Settings' order. A pinned project always goes back to its folder's
// group, and no other project can join one. A new folder group takes a name and colour of its own,
// which the group menu can change.
const ROOT_GROUPS: Record<string, [string, GroupColor]> = {
  'chaos-projects': ['Chaos', 'orange'],
  'other-projects': ['Other', 'blue'],
  'unity-projects': ['Unity', 'green'],
};
const isRootGroup = (group: ProjectGroup) => group.id.startsWith('root:');
const parentDir = (dir: string) => dir.slice(0, dir.lastIndexOf('/'));
/** The project folders from Settings, in order; set by `syncPinned`. */
let pinnedRoots: string[] = [];

function pinGroups() {
  for (const p of state.projects) {
    if (!p.pinned) {
      if (p.groupId?.startsWith('root:')) p.groupId = undefined;
      continue;
    }
    const root = folderName(parentDir(p.path));
    const id = `root:${root}`;
    if (!state.groups.some((g) => g.id === id)) {
      const used = new Set(state.groups.map((g) => g.color));
      const [name, color] = ROOT_GROUPS[root] ?? [
        root.replace(/-projects$/, '').replace(/^./, (c) => c.toUpperCase()),
        (GROUP_COLORS.find(([c]) => !used.has(c)) ?? GROUP_COLORS[0])[0],
      ];
      state.groups.push({ id, name, color });
    }
    p.groupId = id;
  }
  const rank = (p: ProjectState) => {
    if (!p.pinned) return pinnedRoots.length + 1;
    const i = pinnedRoots.indexOf(parentDir(p.path));
    return i < 0 ? pinnedRoots.length : i;
  };
  // A stable sort, so projects keep their order inside each group and after them.
  state.projects.sort((a, b) => rank(a) - rank(b));
}

/** Keeps each group's projects together where its first one sits, and drops groups left empty. */
function normalizeGroups() {
  pinGroups();
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

const inSidebar = () => state.projectList === 'sidebar';

function renderTabs() {
  // Replacing the tab being dragged or renamed would cancel that; rebuild once it ends.
  if (dragProjectId || dragGroupId || document.querySelector('#tabs [contenteditable="true"], #project-tree [contenteditable="true"]')) {
    tabsDirty = true;
    return;
  }
  tabsDirty = false;
  projectTabEls.clear();
  groupTabEls.clear();
  if (inSidebar()) {
    tabsEl.replaceChildren();
    renderProjectTree();
    return;
  }
  projectTreeEl.replaceChildren();
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
  close.title = withKey('Close project', 'close-project');
  const name = h('span', 'tab-name', p.name);
  tab.append(projectIcon(p), name);
  if (p.panes.length > 1) tab.append(h('span', 'tab-count', String(p.panes.length)));
  tab.append(h('span', `dot ${projectStatus(p)}`));
  // A pinned project cannot be closed, so its tab has no close button.
  if (!p.pinned) tab.append(close);
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

// In the left panel the projects form a tree: each group is a heading that folds its projects away,
// and the projects in no group follow as plain rows. Under each project its sessions are branches,
// so the session tab bar is not needed while the tree is in sight: the Liszt sessions and the ones
// running or kept elsewhere, chosen and ordered by the same Show and Sort as the Sessions panel.
// Sessions whose folder belongs to no open project close the tree. A project row opens, renames
// and has the same menu as a tab; reordering and regrouping by dragging stay with the tabs.

interface TreeSession {
  title: string;
  dot: string;
  chip: string;
  kind: PaneKind;
  view?: PaneView;
  row?: SessionRow;
}

/** Sessions shown under a project before a "more" line, besides its own Liszt sessions. */
const TREE_OUTSIDE_LIMIT = 6;
/** Projects whose every outside session is shown; '' is the closing "other folders" list. */
const treeShowAll = new Set<string>();

function treeSessions(terms: string[]): { byProject: Map<string, TreeSession[]>; elsewhere: TreeSession[] } {
  const matches = (text: string) => terms.every((t) => fold(text).includes(t));
  const rows = sessionRows().filter(FILTERS[state.sessionFilter]);
  const ofPane = new Map(rows.filter((r) => r.view).map((r) => [r.view!.pane.id, r]));
  // Shells have no session row; they show while the filter takes in what runs in Liszt.
  const shells = ['active', 'liszt', 'running', 'all'].includes(state.sessionFilter);
  const byProject = new Map<string, TreeSession[]>();
  for (const p of state.projects) {
    const named = !terms.length || matches(`${p.name} ${p.path}`);
    const list: TreeSession[] = [];
    for (const pane of p.panes) {
      const v = views.get(pane.id);
      if (!v) continue;
      const r = ofPane.get(pane.id);
      if (pane.kind === 'claude' ? !r : !shells) continue;
      if (!named && !matches(`${displayTitle(v)} ${r?.detail ?? ''} ${pane.branch ?? ''}`)) continue;
      list.push({ title: displayTitle(v), dot: dotClass(v), chip: r && v.status !== 'idle' ? chipText(v) : '', kind: pane.kind, view: v, row: r });
    }
    byProject.set(p.id, list);
  }
  const elsewhere: TreeSession[] = [];
  for (const r of rows.filter((r) => !r.view)) {
    const p = projectFor(r.cwd);
    if (terms.length && !matches(`${r.title} ${r.where} ${r.detail}${p ? ` ${p.name} ${p.path}` : ''}`)) continue;
    const item: TreeSession = { title: r.title, dot: r.dot, chip: r.chip[1], kind: 'claude', row: r };
    (p ? byProject.get(p.id)! : elsewhere).push(item);
  }
  // Under a project its sessions follow Sort, open in Liszt or not, pinned ones first; shells have
  // no session row and close the list in tab order. The projects keep their own order.
  const sort = SORTS[state.sessionSort];
  const bySort = (a: TreeSession, b: TreeSession) =>
    !a.row || !b.row ? Number(!a.row) - Number(!b.row) : Number(b.row.pinned) - Number(a.row.pinned) || sort(a.row, b.row);
  for (const list of byProject.values()) list.sort(bySort);
  elsewhere.sort(bySort);
  return { byProject, elsewhere };
}

function renderProjectTree() {
  const terms = fold(treeSearch.value).split(/\s+/).filter(Boolean);
  const { byProject, elsewhere } = treeSessions(terms);
  // While searching, a project shows when its name or one of its sessions matches.
  const shown = (p: ProjectState) =>
    !terms.length || byProject.get(p.id)!.length > 0 || terms.every((t) => fold(`${p.name} ${p.path}`).includes(t));
  const els: HTMLElement[] = [];
  for (let i = 0; i < state.projects.length; ) {
    const group = groupOf(state.projects[i]);
    if (!group) {
      const p = state.projects[i++];
      if (shown(p)) els.push(...treeProject(p, byProject.get(p.id)!, terms.length > 0));
      continue;
    }
    const members: ProjectState[] = [];
    while (state.projects[i]?.groupId === group.id) members.push(state.projects[i++]);
    const visible = members.filter(shown);
    if (visible.length) els.push(treeGroup(group, visible, byProject, terms.length > 0));
  }
  if (elsewhere.length) {
    els.push(h('div', 'ptree-elsewhere', 'Other folders'));
    els.push(...treeFolders(elsewhere, terms.length > 0));
  }
  // Hidden folders are out of sight, not gone: a line says how many and lists them again.
  const hiddenCount = (state.hiddenFolders ?? []).length;
  if (hiddenCount && !terms.length && state.sessionFilter !== 'archived') {
    const note = h('div', 'ptree-more ptree-hidden-note', `${hiddenCount} hidden ${hiddenCount === 1 ? 'folder' : 'folders'} · show`);
    note.title = 'Click to show a hidden folder or project again, or to list their sessions';
    note.addEventListener('click', () => void hiddenMenu(note));
    els.push(note);
  }
  if (!els.length) els.push(h('div', 'side-note', 'Nothing matches.'));
  projectTreeEl.replaceChildren(...els);
  projectsCountEl.textContent = String(state.projects.length);
  // Shift-click ranges follow the tree's order; a session the tree no longer shows leaves the selection.
  shownSessionIds = [...projectTreeEl.querySelectorAll<HTMLElement>('.ptree-session')].map((el) => el.dataset.key!);
  for (const key of selectedSessions) if (!shownSessionIds.includes(key)) selectedSessions.delete(key);
  if (treeCardKey && !shownSessionIds.includes(treeCardKey)) hideTreeCard();
  if (marquee) paintMarquee();
  // Scrolled to only when the open project or session changes, so redraws leave the scroll alone.
  const here = `${state.activeProjectId}:${focusedPaneId}`;
  if (here !== treeScrolledTo) {
    treeScrolledTo = here;
    projectTreeEl.querySelector('.ptree-session.current, .ptree-row.active')?.scrollIntoView({ block: 'nearest' });
  }
}

let treeScrolledTo = '';

/** A tree session's key in the selection: its Claude session id, or its pane for a shell. */
const treeKey = (s: TreeSession) => (s.row ? s.row.sessionId : `pane:${s.view!.pane.id}`);

/**
 * The selected tree sessions, as session rows and as shells. Right-clicking one of several opens
 * the menu for all of them.
 */
function selectedInTree(): { rows: SessionRow[]; shells: PaneView[] } {
  const rows = sessionRows().filter((r) => selectedSessions.has(r.sessionId));
  const shells = [...selectedSessions].flatMap((key) => (key.startsWith('pane:') ? (views.get(key.slice(5)) ?? []) : []));
  return { rows, shells };
}

// Marquee selection: a drag that starts anywhere in the tree draws a box, and the sessions it
// touches are selected, added to the selection when ⌘ or ⇧ is held. A press that does not move is
// left to be a click; the click that ends a drag is swallowed.
interface Marquee {
  x: number;
  /** Where the drag started, in the tree's scrolled content. */
  y: number;
  toX: number;
  toY: number;
  base: Set<string>;
  box?: HTMLElement;
}
let marquee: Marquee | null = null;
let swallowClick = false;

function paintMarquee() {
  const m = marquee!;
  const tree = projectTreeEl.getBoundingClientRect();
  const top = Math.min(m.y, m.toY + projectTreeEl.scrollTop);
  const bottom = Math.max(m.y, m.toY + projectTreeEl.scrollTop);
  const left = Math.min(m.x, m.toX);
  const right = Math.max(m.x, m.toX);
  if (!m.box?.isConnected) {
    m.box = h('div', 'ptree-marquee');
    projectTreeEl.append(m.box);
  }
  Object.assign(m.box.style, {
    top: `${top}px`,
    height: `${bottom - top}px`,
    left: `${left - tree.left}px`,
    width: `${right - left}px`,
  });
  selectedSessions.clear();
  for (const key of m.base) selectedSessions.add(key);
  for (const el of projectTreeEl.querySelectorAll<HTMLElement>('.ptree-session')) {
    const r = el.getBoundingClientRect();
    const elTop = r.top - tree.top + projectTreeEl.scrollTop;
    const hit = elTop < bottom && elTop + r.height > top && r.left < right && r.right > left;
    if (hit) selectedSessions.add(el.dataset.key!);
    el.classList.toggle('selected', selectedSessions.has(el.dataset.key!));
  }
}

projectTreeEl.addEventListener('scroll', () => hideTreeCard());
projectTreeEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.ctrlKey || (e.target as HTMLElement).isContentEditable) return;
  const tree = projectTreeEl.getBoundingClientRect();
  // A press on the scrollbar scrolls.
  if (e.clientX > tree.left + projectTreeEl.clientWidth) return;
  const start = { x: e.clientX, y: e.clientY - tree.top + projectTreeEl.scrollTop };
  const additive = e.metaKey || e.shiftKey;
  const move = (ev: MouseEvent) => {
    if (!marquee) {
      if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
      marquee = { ...start, toX: ev.clientX, toY: ev.clientY - tree.top, base: additive ? new Set(selectedSessions) : new Set() };
    }
    marquee.toX = ev.clientX;
    marquee.toY = ev.clientY - tree.top;
    // Near the top or bottom edge the tree scrolls, so the box can reach past what is in sight.
    if (ev.clientY < tree.top + 16) projectTreeEl.scrollTop -= 12;
    else if (ev.clientY > tree.bottom - 16) projectTreeEl.scrollTop += 12;
    paintMarquee();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (!marquee) return;
    marquee.box?.remove();
    marquee = null;
    swallowClick = true;
    setTimeout(() => (swallowClick = false));
    selectionAnchor = shownSessionIds.find((key) => selectedSessions.has(key));
    renderSessions();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});
projectTreeEl.addEventListener(
  'click',
  (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);

function treeGroup(group: ProjectGroup, members: ProjectState[], byProject: Map<string, TreeSession[]>, searching: boolean): HTMLElement {
  const box = h('div', `ptree-group${group.collapsed ? ' collapsed' : ''}`);
  box.style.setProperty('--group', groupColor(group));
  const head = h('div', 'ptree-head');
  const name = h('span', 'tgroup-name', group.name || groupLabel(group));
  head.append(h('span', 'ptree-swatch'), name);
  head.append(h('span', 'ptree-count', String(members.length)));
  // The open project stays in sight when its group collapses; the dot speaks for the hidden ones.
  const shown = group.collapsed && !searching ? members.filter((p) => p.id === state.activeProjectId) : members;
  const status = group.collapsed ? groupStatus(members.filter((p) => !shown.includes(p))) : '';
  if (status) head.append(h('span', `dot ${status}`));
  head.title = `${groupLabel(group)}\nClick to ${group.collapsed ? 'expand' : 'collapse'}, right-click for more`;
  head.addEventListener('click', () => name.isContentEditable || toggleGroup(group));
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void groupMenu(group, pointer(e));
  });
  groupTabEls.set(group.id, head);
  box.append(head, ...shown.flatMap((p) => treeProject(p, byProject.get(p.id)!, searching)));
  return box;
}

/** A project's row, followed by its sessions while it is expanded. */
function treeProject(p: ProjectState, sessions: TreeSession[], searching: boolean): HTMLElement[] {
  const open = searching ? sessions.length > 0 : (p.treeOpen ?? (p.id === state.activeProjectId || p.panes.length > 0));
  const row = h('div', `ptree-row${p.id === state.activeProjectId ? ' active' : ''}`);
  const agents = projectAgents[p.path] ?? [];
  const agentsLine = agents.length ? `\n${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}: ${agents.join(', ')}` : '';
  row.title = `${p.name}\n${p.path}${agentsLine}\n${sessions.length ? `Double-click to ${open ? 'fold' : 'unfold'} its sessions, right` : 'Right'}-click for more`;
  const name = h('span', 'tab-name', p.name);
  const add = iconEl(ICONS.plus, 'ptree-add');
  add.title = withKey('New Claude session', 'new-claude');
  row.append(projectIcon(p), name, add);
  if (agents.length) {
    const badge = iconEl(ICONS.agent, 'ptree-agents');
    badge.append(String(agents.length));
    badge.title = agentsLine.trim();
    row.append(badge);
  }
  // Folded, the count says how many sessions are tucked away under it.
  if (!open && sessions.length) row.append(h('span', 'tab-count', String(sessions.length)));
  row.append(h('span', `dot ${projectStatus(p)}`));
  row.addEventListener('click', (e) => {
    if (name.isContentEditable) return;
    // The first click opens the project and redraws the tree, so the second one lands on a new
    // row and no dblclick fires; the click's own count tells a double-click instead.
    if (e.detail === 2 && !add.contains(e.target as Node)) {
      if (!sessions.length) return;
      p.treeOpen = !open;
      renderTabs();
      return save();
    }
    if (add.contains(e.target as Node)) {
      if (state.activeProjectId !== p.id) activateProject(p.id);
      return void addPane('claude', p);
    }
    activateProject(p.id);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void projectMenu(p, pointer(e));
  });
  projectTabEls.set(p.id, row);
  return open && sessions.length ? [row, treeBranch(p.id, sessions)] : [row];
}

/** Folders under "Other folders" whose sessions are listed; the rest stay folded. */
const treeOpenFolders = new Set<string>();

/**
 * Sessions whose folder belongs to no open project, one folded row per folder (a repository's
 * worktrees go under its main checkout), most recently active first as the sessions are sorted.
 */
function treeFolders(sessions: TreeSession[], searching: boolean): HTMLElement[] {
  const byFolder = new Map<string, TreeSession[]>();
  for (const s of sessions) {
    const key = folderKey(s.row!.cwd);
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key)!.push(s);
  }
  return [...byFolder].flatMap(([dir, list]) => {
    const open = searching || treeOpenFolders.has(dir);
    const hidden = isHiddenFolder(dir);
    const row = h('div', `ptree-row ptree-folder${hidden ? ' hidden-folder' : ''}`);
    row.append(iconEl(KIND_GLYPH.folder, 'ptree-folder-icon'), h('span', 'tab-name', folderLabel(dir)));
    row.append(h('span', 'tab-count', String(list.length)));
    const status = list.some((s) => s.dot === 'running') ? 'running' : list.some((s) => s.dot === 'unread') ? 'unread' : '';
    row.append(h('span', `dot ${status}`));
    row.title = `${dir}${hidden ? '\nHidden from Liszt' : ''}\nClick to ${open ? 'fold' : 'unfold'}, right-click for more`;
    row.addEventListener('click', () => {
      if (searching) return;
      if (open) treeOpenFolders.delete(dir);
      else treeOpenFolders.add(dir);
      renderTabs();
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void folderMenu(dir, list.flatMap((s) => s.row ?? []), pointer(e));
    });
    return open ? [row, treeBranch(`folder:${dir}`, list)] : [row];
  });
}

/** The hidden folders and projects, each to be shown again, and their sessions under Archived. */
async function hiddenMenu(at: MenuAnchor) {
  const hidden = state.hiddenFolders ?? [];
  const choice = await showMenu(
    [
      ...hidden.map((dir) => ({ label: `Show ${folderLabel(dir)}`, id: `show:${dir}` })),
      'separator',
      { label: 'List Their Sessions', id: 'archived', key: 'l' },
    ],
    at,
  );
  if (choice === 'archived') return setSessionFilter('archived');
  if (choice?.startsWith('show:')) showHidden(choice.slice('show:'.length));
}

/** Shown again, a hidden project folder comes back as the always-open project it was. */
function showHidden(dir: string) {
  hideFolder(dir, false);
  void syncPinned();
}

/**
 * Hides an always-open project: its folder joins the hidden folders, so it is not opened again and
 * its sessions leave the tree as a hidden folder's do. Its panes close as a closed project's do.
 */
async function hideProject(project: ProjectState) {
  if (projectBusy(project) && !(await askDialog(`${project.name} has sessions still working. Hide the project?`, { ok: 'Hide' }))) return;
  if (!state.projects.includes(project)) return;
  const key = trimPath(project.path);
  state.hiddenFolders = [...(state.hiddenFolders ?? []).filter((f) => f !== key), key];
  project.pinned = undefined;
  await closeProject(project, { ask: false });
}

/** A folder's menu: open it as a project, hide it from Liszt or show it again, archive its sessions. */
async function folderMenu(dir: string, rows: SessionRow[], at: MenuAnchor) {
  const hidden = isHiddenFolder(dir);
  const archivable = rows.filter((r) => !r.archived && !r.live);
  const choice = await showMenu(
    [
      { label: 'Add as Project', id: 'project', key: 'p' },
      { label: 'Reveal in Finder', id: 'reveal', key: 'r' },
      'separator',
      hidden ? { label: 'Show Folder in Liszt', id: 'show', key: 'h' } : { label: 'Hide Folder from Liszt', id: 'hide', key: 'h' },
      {
        label: `Archive ${archivable.length} ${archivable.length === 1 ? 'Session' : 'Sessions'}`,
        id: 'archive',
        key: 'a',
        enabled: archivable.length > 0,
      },
    ],
    at,
  );
  switch (choice) {
    case 'project': {
      const project = projectFor(dir) ?? createProject(dir);
      activateProject(project.id);
      renderTabs();
      return save();
    }
    case 'reveal':
      return void api.reveal(dir);
    case 'hide':
    case 'show':
      // Shown again, the folder may have been hidden as a parent of this one.
      if (choice === 'show') state.hiddenFolders = (state.hiddenFolders ?? []).filter((f) => !within(dir, f));
      return hideFolder(dir, choice === 'hide');
    case 'archive':
      await Promise.all(archivable.map((r) => archiveSession(r, true, false)));
      return renderTabs();
  }
}

/** Session rows under a project: its own first, then a few of the outside ones and a line for the rest. */
function treeBranch(key: string, sessions: TreeSession[]): HTMLElement {
  const box = h('div', 'ptree-sessions');
  // Every session open in Liszt shows; the others up to a limit, all in the order given.
  const outside = sessions.filter((s) => !s.view);
  const all = treeShowAll.has(key);
  const listed = new Set(all ? outside : outside.slice(0, TREE_OUTSIDE_LIMIT));
  box.append(...sessions.filter((s) => s.view || listed.has(s)).map(treeSession));
  if (outside.length > TREE_OUTSIDE_LIMIT) {
    const more = h('div', 'ptree-more', all ? 'Show fewer' : `${outside.length - TREE_OUTSIDE_LIMIT} more…`);
    more.addEventListener('click', () => {
      if (all) treeShowAll.delete(key);
      else treeShowAll.add(key);
      renderTabs();
    });
    box.append(more);
  }
  return box;
}

function treeSession(s: TreeSession): HTMLElement {
  const v = s.view;
  const el = h('div', 'ptree-session');
  const key = treeKey(s);
  el.dataset.key = key;
  if (selectedSessions.has(key)) el.classList.add('selected');
  const onScreen = Boolean(v && v.project.id === state.activeProjectId);
  if (v && onScreen && v.pane.id === focusedPaneId) el.classList.add('current');
  if (v && onScreen && isVisible(v)) el.classList.add('visible');
  if (!v) el.classList.add('outside');
  if (s.row && !s.row.open) el.classList.add('gone');
  if (s.dot === 'unread') el.classList.add('unread');
  el.append(iconEl(s.kind === 'claude' ? ICONS.claude : ICONS.shell, `stab-icon ${s.kind}`), h('span', `dot ${s.dot}`));
  if (s.row?.pinned) el.append(iconEl(ICONS.pin, 'srow-pin'));
  el.append(h('span', 'ptree-session-title', s.title));
  if (s.chip) el.append(h('span', 'ptree-session-chip', s.chip));
  const close = iconEl(ICONS.close, 'ptree-close');
  if (v) {
    close.title = withKey('Close session', 'close-pane');
    el.append(close);
  }
  el.addEventListener('mouseenter', () => showTreeCard(key, el, s));
  el.addEventListener('mouseleave', () => hideTreeCard(true));
  if (treeCardKey === key) requestAnimationFrame(() => el.isConnected && showTreeCard(key, el, s, true));
  el.addEventListener('click', (e) => {
    hideTreeCard();
    if (v && close.contains(e.target as Node)) return void closePane(v);
    if (e.shiftKey) return selectRange(key);
    if (e.metaKey) return toggleSelected(key);
    clearSelection();
    if (v) return revealPane(v);
    s.row?.open?.();
  });
  el.addEventListener('auxclick', (e) => e.button === 1 && v && closePane(v));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    hideTreeCard();
    // On a Mac ⌃-click arrives as a right-click; here it picks the session, as ⌘-click does.
    if (e.ctrlKey && e.button === 0) return toggleSelected(key);
    if (selectedSessions.has(key) && selectedSessions.size > 1) {
      const { rows, shells } = selectedInTree();
      return void sessionRowsMenu(rows, pointer(e), shells);
    }
    clearSelection();
    if (v) void sessionMenu(v, 'head', pointer(e));
    else if (s.row) void sessionRowMenu(s.row, pointer(e));
  });
  return el;
}

// Hovering a tree session shows a card with its whole name, where it runs and when it last changed,
// in place of a title tooltip the narrow panel would cut short. The tree redraws on every status
// change, so the card follows the redrawn row by its key and refreshes its text.

function clockTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function showTreeCard(key: string, el: HTMLElement, s: TreeSession, now = false) {
  clearTimeout(treeCardTimer);
  treeCardKey = key;
  const fill = () => {
    if (treeCardKey !== key || !el.isConnected) return;
    const v = s.view;
    const time = s.row?.time ?? v?.since;
    const lines: HTMLElement[] = [h('div', 'tree-card-title', s.title)];
    const where = v ? [v.project.name, v.pane.branch ? `⎇ ${v.pane.branch}` : ''].filter(Boolean).join(' · ') : (s.row?.cwd ?? '');
    if (where) lines.push(h('div', 'tree-card-where', where));
    if (time) lines.push(h('div', 'tree-card-time', `Updated ${duration(Date.now() - time)} ago · ${clockTime(time)}`));
    const detail = s.row?.detail ?? (v ? v.activity : '');
    if (detail) lines.push(h('div', 'tree-card-detail', detail));
    treeCard.replaceChildren(...lines);
    treeCard.classList.add('open');
    const box = el.getBoundingClientRect();
    const card = treeCard.getBoundingClientRect();
    const left = Math.min(box.right + 8, window.innerWidth - card.width - 8);
    const top = Math.max(6, Math.min(box.top, window.innerHeight - card.height - 6));
    treeCard.style.left = `${left}px`;
    treeCard.style.top = `${top}px`;
  };
  // Moving along the list keeps the card up and swaps its text; a first hover waits a moment.
  if (now || treeCard.classList.contains('open')) fill();
  else treeCardTimer = setTimeout(fill, 450);
}

/** `soon` leaves a moment to reach the next row, which then takes the card over without the wait. */
function hideTreeCard(soon: unknown = false) {
  clearTimeout(treeCardTimer);
  const close = () => {
    treeCardKey = undefined;
    treeCard.classList.remove('open');
  };
  if (soon === true) treeCardTimer = setTimeout(close, 120);
  else close();
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

async function closeGroup(group: ProjectGroup) {
  const members = groupMembers(group).filter((p) => !p.pinned);
  const busy = members.filter(projectBusy).map((p) => p.name);
  if (busy.length && !(await askDialog(`${busy.join(', ')} ${busy.length === 1 ? 'has' : 'have'} sessions still working. Close the group's projects?`, { ok: 'Close' }))) return;
  for (const p of members) if (state.projects.includes(p)) void closeProject(p, { ask: false });
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
      // A folder's group holds exactly that folder's projects, which are always open.
      ...(isRootGroup(group)
        ? []
        : ([
            'separator',
            { label: 'Add Project to Group…', id: 'add', key: 'p' },
            'separator',
            { label: 'Ungroup', id: 'ungroup', key: 'u' },
            { label: 'Close Group', id: 'close', key: 'c' },
          ] as MenuEntry[])),
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
  const otherGroups = state.groups.filter((g) => g.id !== project.groupId && !isRootGroup(g));
  const entries: MenuEntry[] = [{ label: 'Rename…', id: 'rename', key: 'r' }];
  if (project.name !== folderName(project.path)) entries.push({ label: 'Use Folder Name', id: 'reset-name', key: 'n' });
  if (!project.pinned) entries.push(
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
  if (project.groupId && !project.pinned) entries.push({ label: 'Remove from Group', id: 'ungroup', key: 'u' });
  entries.push(
  );
  // Folding is how a tab shrinks; a row in the left panel has nothing to fold.
  if (!inSidebar()) entries.push(
    'separator',
    { label: project.folded ? 'Unfold' : 'Fold', id: 'fold', key: 'e' },
    { label: 'Fold Others', id: 'fold-others', key: 'o', enabled: others.some((p) => !p.folded) },
    { label: 'Unfold All', id: 'unfold-all', key: 'a', enabled: state.projects.some((p) => p.folded) },
  );
  entries.push(
    'separator',
    { label: 'Choose Icon…', id: 'icon-choose', key: 'i' },
    { label: 'Detect Icon Again', id: 'icon-detect' },
    'separator',
    { label: 'New Agent Session', id: 'agent', key: 't' },
  );
  const agentNames = projectAgents[project.path] ?? [];
  if (agentNames.length) entries.push({
    label: 'Remove Agent',
    key: 'x',
    submenu: agentNames.map((n) => {
      const busy = agentInUse(project, n);
      return { label: busy ? `${n} (in use)` : n, id: `remove-agent:${n}`, enabled: !busy, danger: true };
    }),
  });
  entries.push(
    { label: 'Open Terminal Here', id: 'shell', key: 's' },
    { label: 'Reveal in Finder', id: 'reveal', key: 'f' },
    'separator',
    // An always-open project cannot close, but it can be hidden until shown again.
    project.pinned ? { label: 'Hide Project', id: 'hide', key: 'h' } : { label: 'Close Project', id: 'close', key: 'c' },
  );
  const choice = await showMenu(entries, at);
  // The project may have been closed while the menu was open.
  if (!choice || !state.projects.includes(project)) return;
  if (choice.startsWith('remove-agent:')) return void removeAgent(project, choice.slice('remove-agent:'.length));
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
    case 'agent':
      return void newAgent(project);
    case 'shell':
      // A session spawns only in the open project, so the project comes forward first.
      if (state.activeProjectId !== project.id) activateProject(project.id);
      return void addPane('shell', project);
    case 'reveal':
      return api.reveal(project.path);
    case 'close':
      return closeProject(project);
    case 'hide':
      return void hideProject(project);
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

// Every folder in ~/chaos-projects, ~/other-projects and ~/unity-projects is a pinned project: it is
// opened on its own, its tab leads the row and it cannot be closed. Folders made since are picked up
// when the window comes back to the front; a pinned folder that is gone becomes an ordinary project.
let pinnedAt = 0;
/** Agent checkouts beside each pinned project, by the project's folder. */
let projectAgents: Record<string, string[]> = {};

async function syncPinned() {
  pinnedAt = Date.now();
  const list = await api.pinnedProjects();
  // A project folder hidden from Liszt is not opened again until it is shown.
  const hidden = new Set(state.hiddenFolders ?? []);
  const dirs = new Set(list.dirs.filter((d) => !hidden.has(trimPath(d))));
  let changed = list.roots.join('\n') !== pinnedRoots.join('\n') || JSON.stringify(list.agents) !== JSON.stringify(projectAgents);
  pinnedRoots = list.roots;
  projectAgents = list.agents;
  for (const p of state.projects) {
    const pinned = dirs.has(p.path);
    if (Boolean(p.pinned) !== pinned) changed = true;
    p.pinned = pinned || undefined;
    dirs.delete(p.path);
  }
  for (const dir of dirs) {
    createProject(dir).pinned = true;
    changed = true;
  }
  if (!changed) return;
  normalizeGroups();
  emptyEl.hidden = state.projects.length > 0;
  renderTabs();
  save();
}

function createProject(dir: string): ProjectState {
  const project: ProjectState = {
    id: uuid(),
    name: folderName(dir),
    path: dir,
    panes: [],
    layout: null,
    // Project tabs open folded: only the icon and status show until the tab is unfolded.
    folded: true,
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

/** Opens a Claude session in Liszt's own empty folder, for a question that belongs to no project. */
async function quickChat() {
  const dir = await api.quickChatFolder();
  let project = projectFor(dir);
  if (!project) {
    project = createProject(dir);
    project.name = 'Quick chat';
    renderTabs();
  }
  if (state.activeProjectId !== project.id) activateProject(project.id);
  addPane('claude', project);
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
  void closePane(v, { ask: false, stop: false });
  const project = projectFor(dir) ?? createProject(dir);
  if (follow) activateProject(project.id);
  const moved = addPane('claude', project, { sessionId, title: customTitle, ...worktreeOptions(project, dir) });
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
async function closeProject(project: ProjectState, { ask = true } = {}) {
  if (project.pinned) return;
  if (ask && projectBusy(project)) {
    if (!(await askDialog(`${project.name} has sessions still working. Close the project?`, { ok: 'Close' }))) return;
    if (!state.projects.includes(project) || project.pinned) return;
  }
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

/** Folders a Claude session works in: Liszt's panes and every running session on the machine. */
function claudeDirs(): string[] {
  return [
    ...[...views.values()].filter((v) => v.pane.kind === 'claude').map((v) => v.pane.cwd ?? v.project.path),
    ...agents.filter((a) => !a.ended).map((a) => a.cwd),
  ];
}

/** An agent's checkout beside the project's folder, as `/open-agents` lays them out. */
const agentDir = (project: ProjectState, name: string) => `${parentDir(project.path)}/${folderName(project.path)}-${name}`;

/** Whether a Claude session works in the agent's checkout. */
function agentInUse(project: ProjectState, name: string): boolean {
  const dir = agentDir(project, name);
  return claudeDirs().some((d) => samePath(d, dir) || trimPath(d).startsWith(`${dir}/`));
}

/** Removes an agent's checkout and branch, after asking; work it would lose is named and asked about again. */
async function removeAgent(project: ProjectState, name: string) {
  if (agentInUse(project, name)) return void tell(`${name} is in use.\n\nA Claude session works in ${agentDir(project, name)}. Close it first.`);
  const sure = await askDialog(`Remove ${name} from ${project.name}?\n\nIts checkout ${agentDir(project, name)} and its branch agent/${name} are deleted.`, {
    ok: 'Remove Agent',
    danger: true,
  });
  if (!sure) return;
  let res = await api.removeAgent(project.path, name, false);
  if (!res.ok && res.unsafe) {
    const anyway = await askDialog(`${name} holds work that would be lost.\n\n${res.unsafe.join('\n')}\n\nThis cannot be undone.`, {
      ok: 'Delete Anyway',
      danger: true,
    });
    if (!anyway) return;
    res = await api.removeAgent(project.path, name, true);
  }
  if (!res.ok) return void tell(`Could not remove ${name}.\n\n${res.error}`);
  void syncPinned();
}

/**
 * Opens a Claude session in the lowest agent checkout of the project's repository no session works
 * in, `<repo>-agentN` beside the repo, made on `agent/agentN` when it does not exist yet.
 */
async function newAgent(project: ProjectState) {
  const had = projectAgents[project.path]?.length ?? 0;
  const existing = had ? `${project.name} has ${had} ${had === 1 ? 'agent checkout' : 'agent checkouts'}; a free one is reused, otherwise a new one is made.` : 'A new checkout is made beside the project, a full copy of the repository that can take minutes for a big one.';
  const sure = await askDialog(`Open a new agent in ${project.name}?\n\nThe agent works in its own checkout, ${folderName(project.path)}-agentN on agent/agentN. ${existing}`, { ok: 'Open Agent' });
  if (!sure || !state.projects.includes(project)) return;
  const res = await api.addAgent(project.path, claudeDirs());
  if (!state.projects.includes(project)) return;
  if (!res.ok) return void tell(`Could not open an agent: ${res.error}`);
  if (state.activeProjectId !== project.id) activateProject(project.id);
  const v = addPane('claude', project, { cwd: res.cwd, branch: res.branch, name: res.name });
  if (!v) return;
  v.pane.title = res.name;
  renderTitle(v);
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

async function finishTask(project: ProjectState, task: TaskState) {
  const v = task.paneId ? views.get(task.paneId) : undefined;
  if (v && !(await closePane(v))) return;
  task.paneId = undefined;
  setTaskStatus(project, task, 'done');
}

async function removeTaskWorktree(project: ProjectState, task: TaskState) {
  if (!task.worktree) return;
  if (!(await askDialog(`Remove the worktree of "${task.title}"?\n\n${task.worktree}\n\nThe branch ${task.branch} is kept.`, { ok: 'Remove', danger: true }))) return;
  if (!task.worktree) return;
  const v = task.paneId ? views.get(task.paneId) : undefined;
  if (v && !(await closePane(v))) return;
  const res = await api.removeWorktree(project.path, task.worktree);
  if (!res.ok) {
    void tell(`Git did not remove the worktree:\n\n${res.error}`);
    return;
  }
  task.worktree = undefined;
  task.cwd = undefined;
  renderTasks();
  save();
}

async function deleteTask(project: ProjectState, task: TaskState) {
  if (task.worktree && !(await askDialog(`Delete "${task.title}"? Its worktree stays on disk:\n\n${task.worktree}`, { ok: 'Delete', danger: true }))) return;
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

const STATUS_ORDER: Record<Status, number> = { attention: 0, running: 1, waiting: 2, starting: 3, listening: 4, idle: 4, exited: 5 };
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
  /** Its folder is hidden from Liszt; it is shown as an archived one is. */
  hidden: boolean;
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

const SHOWS: Record<SessionFilter, (r: SessionRow) => boolean> = {
  // Only what is open: a Liszt pane or a session running elsewhere. Closed ones wait under All.
  active: (r) => r.group !== 'stopped' && Boolean(r.open),
  liszt: (r) => r.group === 'liszt',
  running: (r) => r.live,
  unread: (r) => r.unread,
  pinned: (r) => r.pinned,
  archived: (r) => r.archived || r.hidden,
  all: () => true,
};
/** A hidden folder's sessions are listed only under Archived, while nothing runs them. */
const FILTERS = Object.fromEntries(
  Object.entries(SHOWS).map(([k, show]) => [k, (r: SessionRow) => show(r) && (k === 'archived' || !r.hidden || r.group !== 'stopped')]),
) as Record<SessionFilter, (r: SessionRow) => boolean>;

const SORTS: Record<SessionSort, (a: SessionRow, b: SessionRow) => number> = {
  status: (a, b) => a.rank - b.rank || b.time - a.time,
  recent: (a, b) => b.time - a.time,
  name: (a, b) => a.title.localeCompare(b.title),
  // Rows are grouped by project first; inside a project the ones that need you come first.
  project: (a, b) => a.rank - b.rank || b.time - a.time,
};

const trimPath = (dir: string) => dir.replace(/(.)\/+$/, '$1');
const samePath = (a: string, b: string) => trimPath(a) === trimPath(b);

/** The repository each folder is in, asked once per folder; null when it is in none. */
const repos = new Map<string, RepoOf | null>();
const reposAsked = new Set<string>();
let reposQueued: string[] = [];

/** Asks for the folders not known yet; rows drawn meanwhile are drawn again once they are. */
function askRepos(dirs: string[]): Promise<void> {
  const fresh = [...new Set(dirs.map(trimPath))].filter((d) => !reposAsked.has(d));
  if (!fresh.length) return Promise.resolve();
  for (const d of fresh) reposAsked.add(d);
  return api.repoOf(fresh).then((found) => {
    fresh.forEach((d, i) => repos.set(d, found[i] ?? null));
    renderSessions();
  });
}

function repoOf(dir: string): RepoOf | null | undefined {
  const d = trimPath(dir);
  if (!repos.has(d) && !reposAsked.has(d)) {
    // Every folder a render looks up goes out in one request.
    if (!reposQueued.length) queueMicrotask(() => void askRepos(reposQueued.splice(0)));
    reposQueued.push(d);
  }
  return repos.get(d);
}

const within = (sub: string, parent: string) => !parent || sub === parent || sub.startsWith(`${parent}/`);

/**
 * The project a folder's sessions go under: the project of that very folder, otherwise the project
 * of the repository's main checkout when the folder is in one of its worktrees, such as an agent's.
 */
function projectFor(dir: string): ProjectState | undefined {
  const exact = state.projects.find((p) => samePath(p.path, dir));
  if (exact) return exact;
  const repo = repoOf(dir);
  if (!repo) return;
  return state.projects.find((p) => {
    const r = repoOf(p.path);
    return r?.root === repo.root && r.top === r.root && within(repo.sub, r.sub);
  });
}

/** What a pane opened in `dir` needs when the project is the repository's rather than the folder's. */
function worktreeOptions(project: ProjectState, dir: string): PaneOptions {
  if (samePath(project.path, dir)) return {};
  return { cwd: trimPath(dir), branch: repos.get(trimPath(dir))?.branch };
}
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Lowercase without accents, so "gecis" finds "Geçiş" and "istanbul" finds "İstanbul". */
const fold = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');

/** Liszt's archive choice wins over the Claude app's. */
const isArchived = (sessionId: string, inApp = false) => state.sessionMarks[sessionId]?.archived ?? inApp;
/** Deleted from Liszt and run by nothing, so its row stays hidden. */
const isDeleted = (sessionId: string) => Boolean(state.sessionMarks[sessionId]?.deleted);
/** Marked unread while no Liszt pane has it; a pane keeps its own. */
const isMarkedUnread = (sessionId: string) => Boolean(state.sessionMarks[sessionId]?.unread);

// Folders hidden from Liszt keep their sessions; those leave the tree and the Sessions panel under
// every Show but Archived, which lists them again, and from there the folder's menu
// shows it once more.

/** A folder name a tool made up: a UUID or a job's hex id, such as Creative Studio's works or ~/.claude/jobs. */
const GENERATED = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}(-[0-9a-f]{12})?$/i;

/**
 * The folder a session outside every project is filed under: its repository's main checkout, or its
 * own. Folders a tool made one per run go under the folder that holds them, so a hundred runs make one row.
 */
function folderKey(cwd: string): string {
  const dir = repoOf(cwd)?.root ?? trimPath(cwd);
  const parts = dir.split('/');
  const made = parts.findIndex((part) => GENERATED.test(part));
  return made > 1 ? parts.slice(0, made).join('/') : dir;
}

/** A folder's name, with its parent's when it only holds what a tool made, as `works` does. */
const folderLabel = (dir: string) => (dir.split('/').length > 3 && /^(works|jobs|tmp|runs)$/.test(folderName(dir)) ? `${folderName(parentDir(dir))} › ${folderName(dir)}` : folderName(dir));
const isHiddenFolder = (dir: string) => (state.hiddenFolders ?? []).some((f) => within(trimPath(dir), f) || within(folderKey(dir), f));

function hideFolder(dir: string, hidden: boolean) {
  const key = trimPath(dir);
  const rest = (state.hiddenFolders ?? []).filter((f) => f !== key);
  state.hiddenFolders = hidden ? [...rest, key] : rest;
  // Its sessions leave the selection with the rows that showed them. The tree is redrawn even when
  // the Sessions panel is not what the left panel shows, as it is where the folder was picked.
  renderSessions();
  if (inSidebar()) renderTabs();
  save();
}

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
      hidden: false,
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
      hidden: false,
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
      open: () => void openSession(a.cwd, a.sessionId, named, bgId),
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
      hidden: false,
      unread: isMarkedUnread(s.sessionId),
      live: false,
      dot: '',
      chip: ['chip', archived ? 'Archived' : ''],
      tooltip: gone ? `${s.cwd}\nCannot be opened: ${gone}` : `${s.cwd}\nClick to open in Liszt (claude --resume)`,
      open: gone ? undefined : () => void openSession(s.cwd, s.sessionId, s.title),
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
      hidden: false,
      unread: isMarkedUnread(t.sessionId),
      live: false,
      dot: '',
      chip: ['chip', archived ? 'Archived' : ''],
      tooltip: t.gone ? `${t.cwd}\nCannot be opened: its folder no longer exists` : `${t.cwd}\nClick to open in Liszt (claude --resume)`,
      open: t.gone ? undefined : () => void openSession(t.cwd, t.sessionId, title),
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
      hidden: false,
      unread: Boolean(m.unread),
      live: false,
      dot: '',
      chip: ['chip', m.archived ? 'Archived' : ''],
      tooltip: `${cwd}\nClick to open in Liszt (claude --resume)`,
      open: () => void openSession(cwd, sessionId, title),
    });
  }
  for (const r of rows) {
    r.hidden = isHiddenFolder(r.cwd);
    if (r.hidden && !r.view && !r.chip[1]) r.chip = ['chip', 'Hidden'];
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

/** Shells, picked in the project tree, can only be closed; the rest applies to the Claude sessions. */
async function sessionRowsMenu(rows: SessionRow[], at: MenuAnchor, shells: PaneView[] = []) {
  const list = rows.filter((r) => !pendingSessions.has(r.sessionId));
  if (!list.length && !shells.length) return;
  const n = list.length;
  const unread = !list.some((r) => r.unread);
  const closable = list.filter((r) => r.view || r.live).length + shells.length;
  const archived = !list.every((r) => r.archived);
  const count = (k: number) => `${k} ${k === 1 ? 'Session' : 'Sessions'}`;
  const claude: MenuEntry[] = n
    ? [
        { label: unread ? `Mark ${n} as Unread` : `Mark ${n} as Read`, id: 'unread', key: 'u' },
        'separator',
        { label: closable ? `Close ${count(closable)}` : 'Close Sessions', id: 'close', key: 'c', enabled: closable > 0 },
        archived ? { label: `Archive ${count(n)}`, id: 'archive', key: 'a' } : { label: `Unarchive ${count(n)}`, id: 'unarchive', key: 'a' },
        'separator',
        { label: `Delete ${count(n)}…`, id: 'delete', key: 'd', danger: true },
      ]
    : [{ label: `Close ${count(closable)}`, id: 'close', key: 'c' }];
  const choice = await showMenu(claude, at);
  if (!choice) return;
  // Panes closed while the menu was open are left out.
  const still = list.filter((r) => !r.view || views.get(r.view.pane.id) === r.view);
  const liveShells = shells.filter((v) => views.get(v.pane.id) === v);
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
      if (!(await confirmClose(still))) return renderSessions();
      for (const v of liveShells) if (views.get(v.pane.id) === v) void closePane(v);
      await Promise.all(still.map((r) => closeSession(r, false)));
      return renderSessions();
    case 'archive':
      if (!(await confirmClose(still))) return renderSessions();
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
async function confirmClose(rows: SessionRow[]): Promise<boolean> {
  const busy = rows.filter((r) => (r.view ? isWorking(r.view) : r.live && r.dot === 'running'));
  const outside = rows.filter((r) => !r.view && r.live && !r.bgId);
  if (!busy.length && !outside.length) return true;
  const why = [
    busy.length ? `${busy.length} still working` : '',
    outside.length ? `${outside.length} running outside Liszt` : '',
  ].filter(Boolean);
  return askDialog(`Close ${rows.length} sessions?\n\n${why.join(', ')}. Their conversations are kept and can be resumed.`, { ok: 'Close' });
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
      // A session open in Liszt belongs to its project; only the others can take their folder out of sight.
      ...(r.view
        ? []
        : [
            r.hidden
              ? { label: `Show “${folderLabel(folderKey(r.cwd))}” in Liszt`, id: 'show-folder', key: 'h' }
              : { label: `Hide “${folderLabel(folderKey(r.cwd))}” from Liszt`, id: 'hide-folder', key: 'h' },
          ]),
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
    case 'hide-folder':
    case 'show-folder': {
      const dir = folderKey(r.cwd);
      // Shown again, the folder may have been hidden as a parent of this one.
      if (choice === 'show-folder') state.hiddenFolders = (state.hiddenFolders ?? []).filter((f) => !within(dir, f) && !within(trimPath(r.cwd), f));
      return hideFolder(dir, choice === 'hide-folder');
    }
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
  if (!res.ok) void tell(`${label.replace('…', '')} "${r.title}" failed:\n\n${res.error}`);
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
  if (ask && (busy || !r.bgId) && !(await askDialog(`Close "${r.title}"?\n\nIt runs outside Liszt${busy ? ' and is still working' : ''}. Its conversation is kept and can be resumed.`, { ok: 'Close' }))) return false;
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

/** Sessions deleted while Undo is offered, with the mark each had before, which Undo puts back. */
const undoMarks = new Map<string, SessionMark | undefined>();

/**
 * Deletes the sessions after one question, all at once. They are closed and leave the panel at
 * once, and a notice offers to undo that; Claude Code deletes them only when it is gone.
 */
async function deleteSessions(rows: SessionRow[]) {
  const one = rows.length === 1 ? rows[0] : undefined;
  const bg = rows.filter((r) => r.bgId);
  const running = rows.filter((r) => r.view || r.live).length;
  // Liszt does not write to the app's files, so the app keeps its own entry.
  const inApp = rows.filter((r) => appSessions.some((s) => s.sessionId === r.sessionId)).length;
  const question = one
    ? `Delete "${one.title}"?\n\n${
        one.bgId ? `Claude Code removes the background session ${one.bgId} (claude rm), and its worktree when nothing would be lost. ` : ''
      }Its conversation is moved to the Trash and can no longer be resumed. Undo is offered for a few seconds.${running ? '\n\nIt is closed first.' : ''}${
        inApp ? '\n\nThe Claude app keeps listing it until you delete it there.' : ''
      }`
    : `Delete ${rows.length} sessions?\n\n${
        bg.length ? `Claude Code removes ${bg.length} background sessions (claude rm), and their worktrees when nothing would be lost. ` : ''
      }Their conversations are moved to the Trash and can no longer be resumed. Undo is offered for a few seconds.${running ? `\n\n${running} running are closed first.` : ''}${
        inApp ? `\n\nThe Claude app keeps listing ${inApp} of them until you delete them there.` : ''
      }`;
  if (!(await askDialog(question, { ok: 'Delete', danger: true }))) return renderSessions();
  // Closed now, so nothing runs them while Undo is offered; the conversations are kept until then.
  const closed = await Promise.all(rows.map((r) => (r.view ? closePane(r.view, { ask: false }) : closeSession(r, false))));
  const gone = rows.filter((r, i) => closed[i] && !undoMarks.has(r.sessionId));
  if (!gone.length) return renderSessions();
  for (const r of gone) {
    undoMarks.set(r.sessionId, state.sessionMarks[r.sessionId]);
    // What it had is kept, so a delete that fails on the next start can give it back.
    state.sessionMarks[r.sessionId] = { ...state.sessionMarks[r.sessionId], deleted: true, undoable: true, at: Date.now() };
  }
  // Until the next poll, as closeSession does: a closed pane's background session would otherwise be listed as running elsewhere.
  const ids = new Set(gone.map((r) => r.sessionId));
  agents = agents.flatMap((a) => (!ids.has(a.sessionId) ? [a] : a.kind === 'background' ? [{ ...a, ended: true, state: 'stopped' }] : []));
  renderSessions();
  save();
  undoToast({
    message: gone.length === 1 ? `Deleted "${gone[0].title}"` : `Deleted ${gone.length} sessions`,
    key: keyHint('undo-delete'),
    undo: () => {
      const back = gone.filter((r) => undoMarks.has(r.sessionId));
      undoDelete(back);
      // A Liszt pane opens again on its conversation; one that ran elsewhere stays closed, to be resumed from its row.
      for (const r of back) if (r.view) void openSession(r.cwd, r.sessionId, r.title, r.bgId);
    },
    expire: () => void finishDelete(gone),
  });
}

/** Puts the sessions' rows back as they were. */
function undoDelete(rows: SessionRow[]) {
  for (const r of rows) {
    if (!undoMarks.has(r.sessionId)) continue;
    const mark = undoMarks.get(r.sessionId);
    undoMarks.delete(r.sessionId);
    if (mark) state.sessionMarks[r.sessionId] = mark;
    else delete state.sessionMarks[r.sessionId];
  }
  renderSessions();
  save();
}

/** Has Claude Code delete the sessions once Undo is no longer offered; one that fails comes back. */
async function finishDelete(rows: SessionRow[]) {
  await Promise.all(
    rows.map(async (r) => {
      if (!undoMarks.has(r.sessionId)) return;
      if (await sessionAction(r, 'Deleting…', api.deleteSession(r.sessionId, r.bgId))) deleted(r.sessionId);
      else {
        undoDelete([r]);
        return;
      }
      undoMarks.delete(r.sessionId);
    }),
  );
  renderSessions();
  save();
}

function deleted(sessionId: string) {
  state.sessionMarks[sessionId] = { deleted: true, at: Date.now() };
  agents = agents.filter((a) => a.sessionId !== sessionId);
  // A task would otherwise resume the deleted conversation; it starts a new one in its worktree instead.
  for (const project of state.projects) for (const task of project.tasks) if (task.sessionId === sessionId) task.sessionId = undefined;
}

/** Deletes left waiting for their Undo when Liszt quit are carried out on the next start. */
async function finishLeftDeletes() {
  const left = Object.entries(state.sessionMarks).filter(([, m]) => m.deleted && m.undoable);
  if (!left.length) return;
  await Promise.all(
    left.map(async ([sessionId]) => {
      const res = await api.deleteSession(sessionId);
      if (res.ok) return deleted(sessionId);
      const { deleted: _d, undoable: _u, ...kept } = state.sessionMarks[sessionId];
      state.sessionMarks[sessionId] = kept;
    }),
  );
  renderSessions();
  save();
}

function renderSessions() {
  sessionChips.clear();
  // With the projects in the left panel, the sessions are the tree's branches.
  if (inSidebar()) {
    if (state.sidebar === 'sessions') renderTabs();
    return;
  }
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
async function openSession(cwd: string, sessionId: string, title: string, bgId?: string) {
  // Opening it reads it; from here on its pane keeps whether it is unread.
  markUnread(sessionId, false);
  // Clicked before the repositories were known, an agent's session would open a project of its own.
  await askRepos([cwd, ...state.projects.map((p) => p.path)]);
  const project = projectFor(cwd) ?? createProject(trimPath(cwd));
  if (state.activeProjectId !== project.id) activateProject(project.id);
  const v = addPane('claude', project, { sessionId, bgId, ...worktreeOptions(project, cwd) });
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
  // Claude Code calls a session with only listeners left idle; the Stop hook already said so.
  if (status === 'idle' && v.status === 'listening') return;
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

/** How long a rewind waits for the turn it stopped to end. */
const REWIND_STOP_WAIT = 5000;

/** Stops the turn under way, if any, and waits a little for it to end; true once it has. */
async function stopTurn(v: PaneView, stop: () => void): Promise<boolean> {
  if (v.status !== 'running' && v.status !== 'attention') return true;
  stop();
  const until = Date.now() + REWIND_STOP_WAIT;
  while ((v.status === 'running' || v.status === 'attention') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return views.get(v.pane.id) === v && v.status !== 'running' && v.status !== 'attention';
}

/**
 * Takes the conversation back to just before one of the user's prompts: the session resumes from
 * there, or starts over when it was the first. `edit`: the prompt's text returns to the composer to
 * be sent again. Claude's changes to files can go back too, from the checkpoints Claude Code keeps.
 * A turn under way is stopped first.
 */
async function rewindTo(v: PaneView, prompt: PromptRef, edit: boolean) {
  const r = v.el.getBoundingClientRect();
  const choice = await showMenu(
    [
      { label: 'Rewind the Conversation', id: 'chat', key: 'c' },
      { label: 'Rewind the Conversation and the Code', id: 'code', key: 'b' },
    ],
    { x: r.left + r.width / 2 - 140, y: r.top + r.height / 2 },
  );
  if (!choice || views.get(v.pane.id) !== v) return;
  await stopTurn(v, () => api.chatInterrupt(v.pane.id));
  // Files go back through the running session; one that has ended is started again for it.
  if (choice === 'code' && !(await ensureChat(v))) return;
  if (views.get(v.pane.id) !== v) return;
  const res = await api.chatRewind(v.pane.id, v.pane.sessionId, v.pane.cwd ?? v.project.path, prompt.index, prompt.text, prompt.nth, choice === 'code');
  if (views.get(v.pane.id) !== v) return;
  if (!res.ok) return v.chat?.error(`Could not rewind: ${res.error}`);
  api.kill(v.pane.id);
  v.pane.rewoundTo = res.resumeAt ?? undefined;
  save();
  await spawn(v, Boolean(res.resumeAt), undefined, res.resumeAt ?? undefined);
  if (edit && views.get(v.pane.id) === v) v.chat?.setDraft(res.text || prompt.text);
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
      if ((v.status === 'running' || v.status === 'attention') && workTasks(ev.tasks).length) {
        // Not finished: Claude takes the work up again when its background tasks end.
        v.activity = waitingOn(workTasks(ev.tasks));
        setStatus(v, 'waiting', true);
      } else if (v.status === 'running' || v.status === 'attention') {
        const took = duration(Date.now() - v.since);
        v.activity = `Finished in ${took}${v.actions ? ` · ${v.actions} tool ${v.actions === 1 ? 'call' : 'calls'}` : ''}`;
        finishTurn(v, (ev.tasks ?? []).filter(isListener));
        notify(v, v.activity, 'done');
      }
      if (v.moveTo && !isWorking(v)) void moveSession(v);
      break;
  }

  const task = taskOf(v);
  if (task) {
    if (v.pane.started) task.sessionId = v.pane.sessionId;
    if (ev.event === 'UserPromptSubmit' && task.status === 'review') setTaskStatus(v.project, task, 'doing');
    if (ev.event === 'Stop' && !workTasks(ev.tasks).length && task.status === 'doing') setTaskStatus(v.project, task, 'review');
  }
  v.chat?.setActivity(v.status === 'running' ? v.activity : '');
  save();
}

/** The prompt Claude Code submits itself when a background task ends, and the line that says how. */
const TASK_NOTIFICATION = /^\s*<task-notification>/;
const TASK_SUMMARY = /<summary>([^<]*)<\/summary>/;

/** The background tasks a Stop hook lists that Claude will come back to (not listeners). */
const workTasks = (tasks: BackgroundTask[] | undefined) => (tasks ?? []).filter((t) => !isListener(t));

/** What still listens after the turn, for the chip's tooltip. */
function listeningTo(tasks: BackgroundTask[]): string {
  if (tasks.length > 1) return `Listening on ${tasks.length} monitors`;
  return `Listening · ${tasks[0].label}`;
}

/** What a session waits on, for its activity line. */
function waitingOn(tasks: BackgroundTask[]): string {
  if (tasks.length > 1) return `Waiting on ${tasks.length} background tasks`;
  return `Waiting on ${tasks[0].type === 'shell' ? 'shell' : 'background task'} · ${tasks[0].label}`;
}

// --- Jobs --------------------------------------------------------------------------------------
// Under the tasks, what the shells in every project run: `npm run dev`, a watcher, a server. The
// shells run in Liszt's terminal host, so these keep going while Liszt is closed.

const JOBS_INTERVAL = 2000;
let shells: HostTerm[] = [];

/** A command as ps gives it, with every absolute path cut to its last part. */
const shortCommand = (command: string) => command.replace(/(^|\s)\/(?:[^\s/]+\/)+([^\s/]+)/g, '$1$2');

async function refreshJobs() {
  if (!state.tasksPanel || document.hidden) return;
  shells = await api.shells();
  renderJobs();
}

function renderJobs() {
  const rows: HTMLElement[] = [];
  for (const shell of shells) {
    const v = views.get(shell.id);
    if (!v) continue;
    for (const job of shell.jobs) {
      const row = h('div', `job${job.foreground ? '' : ' bg'}`);
      row.title = `${job.command}\n${v.pane.cwd ?? v.project.path}\n${job.foreground ? 'Holds the terminal' : 'Started with &'} · click to show its terminal`;
      const text = h('div', 'job-text');
      text.append(h('div', 'job-command', shortCommand(job.command)), h('div', 'job-where muted', `${v.project.name} · ${displayTitle(v)}`));
      const stop = iconEl(ICONS.stop, 'job-stop');
      stop.title = 'Stop (Ctrl+C)';
      stop.addEventListener('click', async (e) => {
        e.stopPropagation();
        row.classList.add('stopping');
        await api.stopJob(shell.id, job.pgid);
        await refreshJobs();
      });
      row.append(h('span', 'job-dot'), text, h('span', 'job-age muted', duration(Date.now() - job.since)), stop);
      row.addEventListener('click', () => revealPane(v));
      rows.push(row);
    }
  }
  jobsCountEl.textContent = rows.length ? String(rows.length) : '';
  if (!rows.length) rows.push(h('div', 'side-note', 'No jobs running in terminals.'));
  jobListEl.replaceChildren(...rows);
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
  if (state.sidebar === 'sessions' && !inSidebar()) sessionSearch.focus();
}

/** Lists the projects as top-bar tabs or as a tree in the left panel, which opens to show it. */
function setProjectList(list: 'tabs' | 'sidebar') {
  state.projectList = list;
  document.body.dataset.projects = list;
  paintHints();
  renderTabs();
  if (list === 'sidebar') setSidebar('sessions');
  else save();
}

function setTasksPanel(on: boolean) {
  state.tasksPanel = on;
  document.body.classList.toggle('no-tasks', !on);
  tasksBtn.classList.toggle('on', on);
  if (on) void refreshJobs();
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
  // A project with no sessions leaves the focus on the last project's session, which is not
  // what is on screen.
  const last = focusedPaneId ? views.get(focusedPaneId) : undefined;
  const focused = last?.project.id === state.activeProjectId ? last : undefined;
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
    case 'new-agent': {
      const project = activeProject();
      return void (project && newAgent(project));
    }
    case 'split-right':
      return void addPane('claude', activeProject(), { split: 'right' });
    case 'split-down':
      return void addPane('claude', activeProject(), { split: 'bottom' });
    case 'close-pane':
      if (focused) void closePane(focused);
      return;
    case 'new-project':
      return void newProject();
    case 'quick-chat':
      return void quickChat();
    case 'undo-delete':
      return void undoNewest();
    case 'add-project':
      return void addProject();
    case 'close-project': {
      const project = activeProject();
      if (project) void closeProject(project);
      return;
    }
    case 'toggle-sidebar':
      return toggleSidebar('changes');
    case 'toggle-sessions':
      return toggleSidebar('sessions');
    case 'toggle-project-list':
      return setProjectList(inSidebar() ? 'tabs' : 'sidebar');
    case 'settings':
      return void showSettings();
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

/** How long a new shell's output stays quiet before it counts as at its prompt. */
const PROMPT_QUIET = 200;

api.onData((id, data) => {
  const v = views.get(id);
  v?.term?.write(data);
  // A command waiting for the shell is typed once the shell has drawn its prompt; typed sooner, the
  // terminal echoes it before the prompt as well.
  if (v?.run) {
    clearTimeout(v.runTimer);
    v.runTimer = window.setTimeout(() => {
      if (!v.run || views.get(id) !== v) return;
      api.write(id, `${v.run}\r`);
      v.run = undefined;
    }, PROMPT_QUIET);
  }
  if (v?.rewindClear) {
    clearTimeout(v.rewindClear.timer);
    v.rewindClear.timer = window.setTimeout(() => views.get(id) === v && clearRewoundPrompt(v), PROMPT_QUIET);
  }
  // A draft from the chat is pasted once Claude Code shows its prompt; pasted, its lines do not send it.
  if (v?.typeIn) {
    clearTimeout(v.runTimer);
    v.runTimer = window.setTimeout(() => {
      if (!v.typeIn || views.get(id) !== v || !inTerminal(v) || terminalDraft(v) === null) return;
      api.write(id, `\x1b[200~${v.typeIn}\x1b[201~`);
      v.typeIn = undefined;
    }, PROMPT_QUIET);
  }
});
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
  ['quick-chat', ICONS.quickChat],
  ['tree-quick-chat', ICONS.quickChat],
  ['new-claude', ICONS.claude],
  ['new-shell', ICONS.shell],
  ['toggle-sidebar', ICONS.branch],
  ['toggle-sessions', ICONS.sessions],
  ['toggle-tasks', ICONS.tasks],
  ['open-settings', ICONS.settings],
] as const) {
  byId(id).innerHTML = svg;
}
byId('add-project').innerHTML = ICONS.plus;
byId('new-project').addEventListener('click', () => void newProject());
// New Project's shortcut (⌃N unless changed in Settings): taken before the terminal, where ⌃N would
// step through the prompt history.
window.addEventListener(
  'keydown',
  (e) => {
    const press = { code: e.code, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
    if (!matchesAccelerator(shortcutFor('new-project', shortcuts), press)) return;
    e.preventDefault();
    e.stopPropagation();
    void newProject();
  },
  true,
);
// Undo Delete's shortcut (⌥⌘Z unless changed in Settings) undoes a delete while its notice is
// shown, taken before the terminal and the chat composer; with no notice the key goes on as before.
window.addEventListener(
  'keydown',
  (e) => {
    if (e.repeat) return;
    const press = { code: e.code, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
    if (!matchesAccelerator(shortcutFor('undo-delete', shortcuts), press) || !undoNewest()) return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);
byId('add-project').addEventListener('click', () => void addProject());
byId('quick-chat').addEventListener('click', () => void quickChat());
byId('tree-quick-chat').addEventListener('click', () => void quickChat());
for (const id of ['quick-chat', 'tree-quick-chat']) hoverTip(byId(id), () => 'Quick chat', () => keyHint('quick-chat'));
byId('empty-add').addEventListener('click', () => void addProject());
byId('new-claude').addEventListener('click', () => addPane('claude'));
byId('new-shell').addEventListener('click', () => addPane('shell'));
sidebarBtn.addEventListener('click', () => toggleSidebar('changes'));
sessionsBtn.addEventListener('click', () => toggleSidebar('sessions'));
tasksBtn.addEventListener('click', () => setTasksPanel(!state.tasksPanel));
byId('open-settings').addEventListener('click', () => void showSettings());

function showSettings() {
  return openSettings({
    api,
    projectList: () => state.projectList ?? 'tabs',
    setProjectList,
    changed: (settings) => {
      shortcuts = settings.shortcuts;
      claudeView = settings.claudeView;
      paintHints();
      renderTabs();
      renderSessionBar();
      for (const v of views.values()) paintView(v);
      for (const project of state.projects) if (!project.panes.length) renderLayout(project);
      void syncPinned();
    },
  });
}

/** The shortcuts in the top bar's tooltips, which follow the ones chosen in Settings. */
function paintHints() {
  const titles: Array<[string, string, string]> = [
    ['add-project', 'Add project', 'add-project'],
    ['new-project', "New project: a Claude session that makes the project's folder and moves into it", 'new-project'],
    ['new-shell', 'New shell', 'new-shell'],
    ['toggle-sidebar', 'Changes', 'toggle-sidebar'],
    ['toggle-sessions', inSidebar() ? 'Projects' : 'Sessions', 'toggle-sessions'],
    ['toggle-tasks', 'Tasks', 'toggle-tasks'],
    ['open-settings', 'Settings', 'settings'],
  ];
  for (const [el, text, id] of titles) byId(el).title = withKey(text, id);
  byId('new-claude').title = withKey('New Claude session', 'new-claude') + (keyHint('split-right') ? ` · split right ${keyHint('split-right')}` : '');
  byId('empty-add').textContent = keyHint('add-project') ? `Add project · ${keyHint('add-project')}` : 'Add project';
}
sessionSearch.addEventListener('input', () => renderSessions());
treeSearch.addEventListener('input', () => renderTabs());
treeSearch.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing || !selectedSessions.size) return;
  e.preventDefault();
  clearSelection();
});
// Esc lets go of the sessions picked in the tree, unless something else has the key.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !inSidebar() || !selectedSessions.size) return;
  clearSelection();
});
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
window.addEventListener('focus', () => Date.now() - pinnedAt > 30_000 && void syncPinned());
api.onProjectsChanged(() => void syncPinned());
window.addEventListener('focus', () => void refreshJobs());
setInterval(() => void refreshJobs(), JOBS_INTERVAL);
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
  ({ shortcuts, claudeView } = await api.settings());
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
  document.body.dataset.projects = state.projectList ??= 'tabs';
  paintHints();
  if (!(state.sessionFilter in FILTERS)) state.sessionFilter = 'active';
  if (!(state.sessionSort in SORTS)) state.sessionSort = 'status';
  sessionFilter.set(state.sessionFilter);
  sessionSort.set(state.sessionSort);
  treeFilter.set(state.sessionFilter);
  treeSort.set(state.sessionSort);
  setTasksPanel(state.tasksPanel);
  void askRepos(state.projects.map((p) => p.path));
  for (const project of state.projects) {
    for (const pane of project.panes) createView(project, pane);
    renderLayout(project);
    if (!project.icon || (!project.icon.custom && (!project.icon.image || project.icon.generated))) void detectIcon(project);
    // Every project tab starts folded.
    project.folded = true;
  }
  await syncPinned();
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
  void finishLeftDeletes();
}

void boot();
