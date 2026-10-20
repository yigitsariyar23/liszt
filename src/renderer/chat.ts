// A Claude pane's conversation, drawn from the messages its session streams: what the user sent,
// Claude's replies rendered as Markdown, and each tool call as a line that opens to show what it
// did. The composer at the bottom sends messages, pasted images included, slash commands and `@`
// file mentions with a completion list, and `!` commands that run in the pane's folder and go into
// the conversation without a turn. ↑ and ↓ bring back earlier prompts; a prompt sent while Claude
// works shows queued until Claude takes it up. Above the composer sit Claude's to-do list, the
// background tasks still running, and the permission prompts, questions and plans that wait for an
// answer. A prompt can be edited, which rewinds the conversation to just before it.

import { Marked } from 'marked';
import './chat.css';
import type { PermissionMode, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { promptText } from '../shared/prompts';
import type { ChatAnswer, ChatAsk, ChatImage, ChatInfo } from '../shared/types';
import { h } from './dom';

export interface ChatHost {
  /** `uuid` comes back on the reply that takes the message up. */
  send(text: string, images: ChatImage[], uuid: string): void;
  /** Runs a `!` command in the pane's folder; its input and output join the conversation. */
  bash(command: string): Promise<{ stdout: string; stderr: string; code: number }>;
  /** Ends the `!` command the chat is running. */
  cancelBash(): void;
  /** Runs a command in a new terminal next to the chat, where it can keep going. */
  toTerminal(command: string): void;
  /** The files `@` offers, relative to the pane's folder. */
  files(): Promise<string[]>;
  /** Opens the model and effort menu under the model button. */
  pickModel(anchor: HTMLElement): void;
  stopTask(taskId: string): void;
  /** Rewinds the conversation to just before the user's `index`th prompt, whose text was `text`. */
  rewind(index: number, text: string): void;
  answer(id: string, a: ChatAnswer): void;
  interrupt(): void;
  setMode(mode: PermissionMode): void;
  openExternal(url: string): void;
  /** Keys the app handles itself (pane and project shortcuts); true when one was. */
  key(e: KeyboardEvent): boolean;
  /** Cmd+scroll sizes the text; true when it did. */
  wheel(e: WheelEvent): boolean;
}

/** What a new chat's welcome card says: where the session runs, and with what. `info` comes once the session is up. */
export interface Welcome {
  icon: HTMLElement;
  project: string;
  folder: string;
  branch?: string;
  info?: ChatInfo | null;
}

type Block = { type: string; [k: string]: unknown };
type Fields = Record<string, unknown>;

interface ToolRow {
  el: HTMLElement;
  name: string;
  input: Fields;
  body: HTMLElement;
  sub: HTMLElement;
  done: boolean;
}

interface Command {
  name: string;
  description: string;
  argumentHint?: string;
}

/** A line of the completion list. */
interface Choice {
  label: string;
  detail: string;
  apply: () => void;
}

interface Todo {
  id?: string;
  content: string;
  activeForm?: string;
  status: string;
}

const MODES: { mode: PermissionMode; label: string }[] = [
  { mode: 'default', label: 'Ask before edits' },
  { mode: 'acceptEdits', label: 'Accept edits' },
  { mode: 'plan', label: 'Plan mode' },
  { mode: 'auto', label: 'Auto mode' },
];

const str = (f: Fields, k: string) => (typeof f[k] === 'string' ? (f[k] as string) : '');
const base = (p: string) => p.split('/').pop() || p;
const lines = (s: string) => (s ? s.split('\n').length : 0);

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    // Claude's text is shown, never run: raw HTML in it reads as text.
    html: ({ text }) => escapeHtml(text),
  },
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function markdown(el: HTMLElement, text: string) {
  el.innerHTML = md.parse(text, { async: false });
  for (const pre of el.querySelectorAll('pre')) {
    const copy = h('button', 'copy', 'Copy');
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent ?? '');
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
    });
    pre.append(copy);
  }
}

/** The text of a tool result, which comes as a string or as content blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: Block) => (b.type === 'text' ? String(b.text) : b.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** Claude Code's own markup in user turns: a slash command, its output, a finished background task. */
const TAG = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);

/** What a tool call is about, for its line: the file, the command, the pattern. */
function toolSummary(name: string, input: Fields): string {
  const file = str(input, 'file_path') || str(input, 'notebook_path');
  if (file) return base(file);
  switch (name) {
    case 'Bash':
      return str(input, 'description') || str(input, 'command').split('\n')[0];
    case 'Grep':
    case 'Glob':
      return str(input, 'pattern');
    case 'WebFetch':
      return str(input, 'url');
    case 'WebSearch':
      return str(input, 'query');
    case 'Task':
    case 'Agent':
      return str(input, 'description');
    case 'TodoWrite':
      return 'Update the to-do list';
    case 'TaskCreate':
      return str(input, 'subject');
    case 'TaskUpdate':
      return `#${str(input, 'taskId')}${str(input, 'status') ? ` → ${str(input, 'status').replace('_', ' ')}` : ''}`;
    case 'Skill':
      return str(input, 'skill');
    case 'AskUserQuestion':
      return Array.isArray(input.questions) ? str((input.questions as Fields[])[0] ?? {}, 'question') : '';
    case 'ExitPlanMode':
      return 'Ready to code';
  }
  return str(input, 'description') || str(input, 'command') || str(input, 'path') || str(input, 'query') || '';
}

const TOOL_LABEL: Record<string, string> = {
  Bash: 'Run',
  Read: 'Read',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  Write: 'Write',
  Grep: 'Search',
  Glob: 'Find',
  WebFetch: 'Fetch',
  WebSearch: 'Search web',
  Task: 'Agent',
  Agent: 'Agent',
  TodoWrite: 'To-dos',
  TaskCreate: 'To-do',
  TaskUpdate: 'To-do',
  NotebookEdit: 'Edit notebook',
  Skill: 'Skill',
  AskUserQuestion: 'Question',
  ExitPlanMode: 'Plan',
};

const toolLabel = (name: string) => TOOL_LABEL[name] ?? name.replace(/^mcp__([^_]+)__/, '$1 · ');

/** Lines removed and added, like a unified diff without context. */
function diffEl(before: string, after: string): HTMLElement {
  const el = h('div', 'diff');
  for (const line of before ? before.split('\n') : []) el.append(h('div', 'del', line || ' '));
  for (const line of after ? after.split('\n') : []) el.append(h('div', 'add', line || ' '));
  return el;
}

/** A preformatted block that shows its first lines and opens to the rest. */
function clipped(text: string, cls: string, max = 14): HTMLElement {
  const all = text.replace(/\s+$/, '');
  const rows = all.split('\n');
  const pre = h('pre', cls, rows.length > max ? rows.slice(0, max).join('\n') : all);
  if (rows.length <= max) return pre;
  const wrap = h('div', 'clipped');
  const more = h('button', 'more-lines', `Show ${rows.length - max} more lines`);
  more.addEventListener('click', () => {
    pre.textContent = all;
    more.remove();
  });
  wrap.append(pre, more);
  return wrap;
}

function toolInputEl(name: string, input: Fields): HTMLElement | null {
  switch (name) {
    case 'Bash':
      return clipped(`$ ${str(input, 'command')}`, 'cmd');
    case 'Edit':
      return diffEl(str(input, 'old_string'), str(input, 'new_string'));
    case 'MultiEdit': {
      const el = h('div');
      for (const e of Array.isArray(input.edits) ? (input.edits as Fields[]) : []) el.append(diffEl(str(e, 'old_string'), str(e, 'new_string')));
      return el;
    }
    case 'Write':
      return clipped(str(input, 'content'), 'file');
    case 'TodoWrite': {
      const el = h('ul', 'todos');
      for (const t of Array.isArray(input.todos) ? (input.todos as Fields[]) : []) {
        const li = h('li', str(t, 'status'), str(t, 'content'));
        el.append(li);
      }
      return el;
    }
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'AskUserQuestion':
      return null;
    case 'ExitPlanMode': {
      const el = h('div', 'md');
      markdown(el, str(input, 'plan'));
      return el;
    }
    case 'Task':
    case 'Agent':
      return str(input, 'prompt') ? clipped(str(input, 'prompt'), 'prompt', 6) : null;
  }
  const json = JSON.stringify(input, null, 2);
  return json && json !== '{}' ? clipped(json, 'json', 8) : null;
}

/** When a usage window starts over: in so long when that is within a day, else the day and time. */
function resetsAt(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return '';
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `resets in ${m}m`;
  if (m < 24 * 60) return `resets in ${Math.floor(m / 60)}h ${m % 60}m`;
  return `resets ${new Date(iso).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

export class ChatView {
  readonly el = h('div', 'chat');
  private log = h('div', 'chat-log');
  /** Shown while the conversation is empty; it goes once the first message is in. */
  private welcomeEl = h('div', 'chat-welcome');
  private thread = h('div', 'chat-thread');
  private asksEl = h('div', 'chat-asks');
  private working = h('div', 'chat-working');
  private composer = h('div', 'composer');
  private input = h('textarea', 'composer-input');
  private shots = h('div', 'composer-shots');
  private modeBtn = h('button', 'mode');
  private modelEl = h('button', 'model');
  private sendBtn = h('button', 'send');
  private popup = h('div', 'slash');
  private todosEl = h('div', 'chat-todos');
  private tasksEl = h('div', 'chat-tasks');

  private tools = new Map<string, ToolRow>();
  private asks = new Map<string, HTMLElement>();
  /** Elements made while a reply streamed, waiting for the finished blocks to take them over. */
  private pending: { type: 'text' | 'tool_use'; el: HTMLElement; id?: string; text: string }[] = [];
  private streaming: { msgId: string; blocks: Map<number, { el: HTMLElement; text: string; type: string }> } | null = null;
  private paintQueued = new Set<{ el: HTMLElement; text: string }>();
  private images: ChatImage[] = [];
  private commands: Command[] = [];
  private choice = 0;
  private choices: Choice[] = [];
  private fileList: { at: number; files: Promise<string[]> } | null = null;
  /** Prompts sent, oldest first, for ↑ and ↓; `recall` is where ↑ has got to, and `draft` what was typed before. */
  private prompts: string[] = [];
  private recall = -1;
  private draft = '';
  /** Messages sent while Claude worked, by the uuid the reply that takes them up carries. */
  private queued = new Map<string, HTMLElement>();
  private todos: Todo[] = [];
  /** To-dos made by TaskCreate wait for their number in the tool's result. */
  private newTodos = new Map<string, Todo>();
  private bgTasks = new Map<string, string>();
  private lastBash: HTMLElement | null = null;
  private lastEsc = 0;
  /** The conversation keeps to its end; see follow(). */
  private pinned = true;
  private mode: PermissionMode = 'auto';
  private busy = false;
  private turnStart = 0;
  private timer = 0;

  constructor(private host: ChatHost) {
    this.log.append(this.welcomeEl, this.thread, this.working);
    this.welcomeEl.hidden = true;
    // Whatever joins the conversation first (a prompt, a `!` command, a reply) takes the card away.
    new MutationObserver(() => {
      if (this.thread.childElementCount) this.dismissWelcome();
    }).observe(this.thread, { childList: true });
    this.working.append(h('span', 'spark'), h('span', 'label', 'Working'), h('span', 'elapsed'));

    this.input.rows = 1;
    this.input.placeholder = 'Message Claude…';
    this.input.spellcheck = false;
    this.sendBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>';
    this.sendBtn.title = 'Send (Enter)';
    const bar = h('div', 'composer-bar');
    this.modeBtn.title = 'Permission mode (Shift+Tab)';
    this.modelEl.title = 'Model and effort';
    this.modelEl.hidden = true;
    bar.append(this.modeBtn, this.modelEl, h('span', 'spacer'), this.sendBtn);
    const box = h('div', 'composer-box');
    box.append(this.shots, this.input, bar);
    this.composer.append(this.popup, box);
    this.el.append(this.log, this.todosEl, this.tasksEl, this.asksEl, this.composer);
    this.paintMode();
    this.popup.hidden = true;

    this.input.addEventListener('input', () => {
      this.grow();
      this.complete();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('paste', (e) => this.onPaste(e));
    this.sendBtn.addEventListener('click', () => (this.busy && !this.input.value.trim() ? this.host.interrupt() : this.submit()));
    this.modeBtn.addEventListener('click', () => this.cycleMode());
    this.modelEl.addEventListener('click', () => this.host.pickModel(this.modelEl));
    this.input.addEventListener('click', () => this.complete());
    this.el.addEventListener('wheel', (e) => this.host.wheel(e) && e.preventDefault(), { passive: false });
    this.el.addEventListener('drop', (e) => this.onDrop(e));
    this.el.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    this.log.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') ?? '';
      if (/^https?:\/\//.test(href)) this.host.openExternal(href);
    });
    this.setBusy(false);
    this.follow();
  }

  focus() {
    this.input.focus();
  }

  get hasFocus() {
    return this.el.contains(document.activeElement);
  }

  /** Empties the conversation, for a pane that starts a new session. */
  clear() {
    // A new session gets its card again; a resumed one shows its conversation instead.
    this.welcomeEl.hidden = true;
    this.welcomeEl.classList.remove('leaving');
    this.thread.replaceChildren();
    this.asksEl.replaceChildren();
    this.tools.clear();
    this.asks.clear();
    this.pending = [];
    this.streaming = null;
    this.prompts = [];
    this.queued.clear();
    this.todos = [];
    this.newTodos.clear();
    this.bgTasks.clear();
    this.lastBash = null;
    this.paintTodos();
    this.paintTasks();
    this.setBusy(false);
  }

  /** Puts text in the composer, as a rewind does with the prompt it took back. */
  setDraft(text: string) {
    this.input.value = text;
    this.grow();
    this.focus();
    this.input.setSelectionRange(text.length, text.length);
  }

  /** The model the session runs, for the model button. */
  setModel(model: string, effort?: string) {
    this.modelEl.textContent = `${model.replace(/^claude-/, '')}${effort ? ` · ${effort}` : ''}`;
    this.modelEl.hidden = !model;
  }

  /** Fills the card a new chat shows until its first message. */
  setWelcome(w: Welcome) {
    if (this.thread.childElementCount) return;
    const card = h('div', 'welcome-card');
    const head = h('div', 'welcome-head');
    const where = h('div', 'welcome-where');
    where.append(h('div', 'welcome-project', w.project), h('div', 'welcome-folder', `${w.folder}${w.branch ? ` · ⎇ ${w.branch}` : ''}`));
    head.append(w.icon, where);
    const rows = h('div', 'welcome-rows');
    const row = (label: string, ...value: (HTMLElement | string)[]) => {
      const r = h('div', 'welcome-row');
      const v = h('div', 'welcome-value');
      v.append(...value);
      r.append(h('div', 'welcome-label', label), v);
      rows.append(r);
    };
    const info = w.info;
    // Before the session answers, the rows hold their places.
    row('Model', info === undefined ? '…' : info?.model ? `${info.model}${info.effort ? ` · ${info.effort}` : ''}` : 'Default');
    if (info?.plan) row('Plan', info.plan);
    for (const limit of info?.limits ?? []) {
      const used = Math.max(0, Math.min(100, Math.round(limit.used)));
      const bar = h('div', `welcome-bar${used >= 90 ? ' high' : used >= 70 ? ' mid' : ''}`);
      const fill = h('div', 'welcome-fill');
      fill.style.width = `${used}%`;
      bar.append(fill);
      row(`${limit.window} limit`, bar, h('span', 'welcome-pct', `${used}%`), h('span', 'welcome-reset', limit.resetsAt ? resetsAt(limit.resetsAt) : ''));
    }
    card.append(head, rows, h('div', 'welcome-hint', 'Send a message to start · / commands · @ files · ! shell'));
    this.welcomeEl.replaceChildren(card);
    this.welcomeEl.classList.remove('leaving');
    this.welcomeEl.hidden = false;
  }

  /** Takes the card away, fading it out unless it is not showing. */
  private dismissWelcome() {
    if (this.welcomeEl.hidden || this.welcomeEl.classList.contains('leaving')) return;
    this.welcomeEl.classList.add('leaving');
    const done = () => {
      if (!this.welcomeEl.classList.contains('leaving')) return;
      this.welcomeEl.hidden = true;
      this.welcomeEl.classList.remove('leaving');
    };
    this.welcomeEl.addEventListener('animationend', done, { once: true });
    // In case the animation never runs (a hidden pane).
    setTimeout(done, 600);
  }

  // --- Messages --------------------------------------------------------------------------------

  /** The conversation so far, as read from the session's transcript. */
  history(messages: { type: string; message: unknown; parent_tool_use_id: string | null }[]) {
    // Whatever arrived while the transcript was read (a prompt sent at once) comes after it.
    const later = [...this.thread.childNodes];
    const prompts = this.prompts;
    this.thread.replaceChildren();
    this.prompts = [];
    for (const m of messages) {
      const msg = m.message as { role?: string; content?: unknown } | undefined;
      if (!msg) continue;
      if (m.type === 'assistant') this.assistant(msg.content, m.parent_tool_use_id);
      else if (m.type === 'user') this.user(msg.content, m.parent_tool_use_id);
    }
    this.thread.append(...later);
    this.prompts.push(...prompts);
    this.scroll(true);
  }

  /** One message of the session's stream. */
  event(m: Fields) {
    const stick = this.atBottom();
    const parent = (m.parent_tool_use_id as string | null) ?? null;
    // The reply that takes up a queued message names it.
    for (const id of Array.isArray(m.user_message_uuids) ? (m.user_message_uuids as string[]) : typeof m.user_message_uuid === 'string' ? [m.user_message_uuid] : []) {
      this.queued.get(id)?.classList.remove('queued');
      this.queued.delete(id);
    }
    switch (m.type) {
      case 'stream_event':
        if (!parent) this.stream(m.event as Fields);
        break;
      case 'assistant': {
        const msg = m.message as { content?: unknown };
        this.assistant(msg.content, parent);
        if (m.error && !parent) this.notice(`Error: ${String(m.error)}`, 'error');
        break;
      }
      case 'user':
        if (!m.isReplay) this.user((m.message as { content?: unknown }).content, parent, true);
        break;
      case 'result':
        this.setBusy(false);
        this.streaming = null;
        if (m.subtype !== 'success') {
          const errors = Array.isArray(m.errors) ? (m.errors as string[]).join('\n') : '';
          this.notice(errors || `The turn ended: ${String(m.subtype).replace(/_/g, ' ')}`, 'error');
        } else if (m.is_error && m.result) this.notice(String(m.result), 'error');
        break;
      case 'system':
        this.system(m);
        break;
    }
    this.scroll(stick);
  }

  private system(m: Fields) {
    switch (m.subtype) {
      case 'init':
        if (typeof m.model === 'string') this.setModel(m.model);
        if (typeof m.permissionMode === 'string') this.setModeShown(m.permissionMode as PermissionMode);
        if (!this.commands.length && Array.isArray(m.slash_commands))
          this.commands = (m.slash_commands as string[]).map((name) => ({ name, description: '' }));
        break;
      case 'commands_changed':
        if (Array.isArray(m.commands)) this.commands = m.commands as Command[];
        break;
      case 'status':
        if (typeof m.permissionMode === 'string') this.setModeShown(m.permissionMode as PermissionMode);
        if (m.status === 'compacting') this.notice('Compacting the conversation…', 'info');
        break;
      case 'compact_boundary':
        this.thread.append(h('div', 'divider', 'Conversation compacted'));
        break;
      case 'api_retry':
        this.notice(`API error${m.error_status ? ` ${m.error_status}` : ''}, retrying (attempt ${m.attempt} of ${m.max_retries})…`, 'info');
        break;
      case 'local_command_output':
        if (m.content) this.thread.append(clipped(String(m.content), 'command-output', 40));
        break;
      case 'informational':
        if (m.content) this.notice(String(m.content), m.level === 'warning' ? 'error' : 'info');
        break;
      case 'background_tasks_changed':
        this.bgTasks.clear();
        for (const t of Array.isArray(m.tasks) ? (m.tasks as Fields[]) : []) this.bgTasks.set(str(t, 'task_id'), str(t, 'description') || str(t, 'task_type'));
        this.paintTasks();
        break;
      case 'task_started':
        if (m.is_backgrounded) {
          this.bgTasks.set(String(m.task_id), String(m.description ?? 'Background task'));
          this.paintTasks();
        }
        break;
      case 'task_updated': {
        const patch = (m.patch as Fields) ?? {};
        if (patch.is_backgrounded === true && !this.bgTasks.has(String(m.task_id))) this.bgTasks.set(String(m.task_id), str(patch, 'description') || 'Background task');
        if (['completed', 'failed', 'killed'].includes(str(patch, 'status'))) this.bgTasks.delete(String(m.task_id));
        this.paintTasks();
        break;
      }
      case 'task_notification':
        this.bgTasks.delete(String(m.task_id));
        this.paintTasks();
        break;
    }
  }

  private stream(ev: Fields) {
    switch (ev.type) {
      case 'message_start': {
        const msg = ev.message as Fields;
        this.streaming = { msgId: String(msg.id), blocks: new Map() };
        this.setBusy(true);
        break;
      }
      case 'content_block_start': {
        if (!this.streaming) return;
        const block = ev.content_block as Block;
        const index = Number(ev.index);
        if (block.type === 'text') {
          const el = h('div', 'msg assistant md');
          this.thread.append(el);
          const live = { el, text: '', type: 'text' };
          this.streaming.blocks.set(index, live);
          this.pending.push({ type: 'text', el, text: '' });
        } else if (block.type === 'tool_use') {
          const row = this.toolRow(String(block.id), String(block.name), {}, null);
          this.pending.push({ type: 'tool_use', el: row.el, id: String(block.id), text: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = ev.delta as Fields;
        const live = this.streaming?.blocks.get(Number(ev.index));
        if (!live || delta.type !== 'text_delta') return;
        live.text += String(delta.text);
        this.paintSoon(live);
        break;
      }
    }
  }

  /** Re-renders streamed Markdown at most once a frame. */
  private paintSoon(live: { el: HTMLElement; text: string }) {
    if (this.paintQueued.has(live)) return;
    this.paintQueued.add(live);
    requestAnimationFrame(() => {
      this.paintQueued.delete(live);
      const stick = this.atBottom();
      markdown(live.el, live.text);
      this.scroll(stick);
    });
  }

  private assistant(content: unknown, parent: string | null) {
    if (!Array.isArray(content)) return;
    for (const block of content as Block[]) {
      if (parent) {
        if (block.type === 'tool_use') this.toolRow(String(block.id), String(block.name), block.input as Fields, parent);
        continue;
      }
      if (block.type === 'text') {
        const text = String(block.text ?? '');
        if (!text.trim()) continue;
        const i = this.pending.findIndex((p) => p.type === 'text');
        const el = i >= 0 ? this.pending.splice(i, 1)[0].el : this.thread.appendChild(h('div', 'msg assistant md'));
        markdown(el, text);
      } else if (block.type === 'tool_use') {
        const i = this.pending.findIndex((p) => p.type === 'tool_use' && p.id === block.id);
        if (i >= 0) this.pending.splice(i, 1);
        this.toolRow(String(block.id), String(block.name), (block.input as Fields) ?? {}, null);
        this.trackTodos(String(block.id), String(block.name), (block.input as Fields) ?? {});
      } else if (block.type === 'thinking' && String(block.thinking ?? '').trim()) {
        const details = h('details', 'thinking');
        details.append(h('summary', undefined, 'Thought'), h('div', 'md'));
        markdown(details.lastElementChild as HTMLElement, String(block.thinking));
        this.thread.append(details);
      }
    }
  }

  private user(content: unknown, parent: string | null, live = false) {
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : [];
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue;
      this.toolResult(String(b.tool_use_id), b.content, Boolean(b.is_error));
      this.todoCreated(String(b.tool_use_id), resultText(b.content));
    }
    if (parent) return;
    // Messages sent from this pane are drawn when they are sent.
    const prompt = promptText(content);
    if (prompt !== null) {
      if (!live) this.sent(prompt, imagesOf(blocks));
      return;
    }
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text))
      .join('\n\n');
    if (!text) return;
    // Claude Code wraps what it adds to the conversation itself in tags; the user did not type it.
    const bashIn = TAG('bash-input').exec(text);
    if (bashIn) {
      if (!live) this.bashRun(bashIn[1]);
      return;
    }
    if (TAG('bash-stdout').test(text) || TAG('bash-stderr').test(text)) {
      if (!live && this.lastBash) this.bashOutput(this.lastBash, TAG('bash-stdout').exec(text)?.[1] ?? '', TAG('bash-stderr').exec(text)?.[1] ?? '');
      return;
    }
    const command = TAG('command-name').exec(text);
    if (command) {
      if (live) return;
      const args = TAG('command-args').exec(text)?.[1].trim();
      this.thread.append(h('div', 'msg command', `${command[1]}${args ? ` ${args}` : ''}`));
      return;
    }
    const stdout = TAG('local-command-stdout').exec(text);
    if (stdout) {
      if (stdout[1].trim()) this.thread.append(clipped(stdout[1].replace(/\x1b\[[0-9;]*m/g, ''), 'command-output', 40));
      return;
    }
    const task = TAG('task-notification').exec(text);
    if (task) this.notice(TAG('summary').exec(task[1])?.[1].trim() || 'A background task finished', 'info');
  }

  /** A `!` command, drawn as it starts; its output comes after. */
  private bashRun(command: string): HTMLElement {
    const el = h('div', 'bash-run running');
    const head = h('div', 'bash-head');
    // A command still running here stops, so the two do not run at once (a dev server's port).
    const move = h('button', 'bash-move', 'Run in terminal');
    move.title = 'Run this command in a new terminal next to the chat, where it keeps going after Liszt quits';
    move.addEventListener('click', () => {
      if (el.classList.contains('running') && this.lastBash === el) {
        el.classList.add('moved');
        this.host.cancelBash();
      }
      this.host.toTerminal(command);
    });
    head.append(move, h('div', 'bash-cmd', `! ${command}`));
    el.append(head);
    this.thread.append(el);
    this.lastBash = el;
    return el;
  }

  private bashOutput(el: HTMLElement, stdout: string, stderr: string, code = 0) {
    el.classList.remove('running');
    if (el.classList.contains('moved')) {
      el.append(h('div', 'bash-none', 'Moved to a terminal'));
      if (stdout.trim()) el.append(clipped(stdout, 'out', 20));
      return;
    }
    el.classList.toggle('error', code !== 0 || (!stdout.trim() && Boolean(stderr.trim())));
    if (stdout.trim()) el.append(clipped(stdout, 'out', 20));
    if (stderr.trim()) el.append(clipped(stderr, 'out error', 10));
    if (!stdout.trim() && !stderr.trim()) el.append(h('div', 'bash-none', code ? `Exited with code ${code}` : 'No output'));
  }

  /** Draws a message the user sent. */
  sent(text: string, images: string[] = []): HTMLElement {
    if (text) this.prompts.push(text);
    const el = h('div', 'msg user');
    const edit = h('button', 'edit', 'Edit');
    edit.title = 'Edit this prompt: the conversation goes back to just before it';
    edit.addEventListener('click', () => this.editPrompt(el));
    el.append(edit);
    if (images.length) {
      const row = h('div', 'shots');
      for (const src of images) {
        const img = h('img');
        img.src = src;
        row.append(img);
      }
      el.append(row);
    }
    if (text) el.append(h('div', 'text', text));
    this.thread.append(el);
    return el;
  }

  /** Takes a prompt back: the conversation rewinds to just before it and its text returns to the composer. */
  private editPrompt(el: HTMLElement) {
    const bubbles = [...this.thread.querySelectorAll('.msg.user')];
    const index = bubbles.indexOf(el);
    if (index < 0 || this.busy) return;
    this.host.rewind(index, el.querySelector('.text')?.textContent ?? '');
  }

  // --- To-dos and background tasks -------------------------------------------------------------

  /** Claude's to-do list, from TodoWrite's whole list or TaskCreate and TaskUpdate one item at a time. */
  private trackTodos(id: string, name: string, input: Fields) {
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      this.todos = (input.todos as Fields[]).map((t) => ({ content: str(t, 'content'), activeForm: str(t, 'activeForm'), status: str(t, 'status') }));
    } else if (name === 'TaskCreate') {
      const todo: Todo = { content: str(input, 'subject'), activeForm: str(input, 'activeForm'), status: 'pending' };
      this.todos.push(todo);
      this.newTodos.set(id, todo);
    } else if (name === 'TaskUpdate') {
      const todo = this.todos.find((t) => t.id === str(input, 'taskId'));
      if (todo) {
        if (str(input, 'status')) todo.status = str(input, 'status');
        if (str(input, 'subject')) todo.content = str(input, 'subject');
        if (str(input, 'activeForm')) todo.activeForm = str(input, 'activeForm');
      }
      if (str(input, 'status') === 'deleted') this.todos = this.todos.filter((t) => t !== todo);
    } else return;
    this.paintTodos();
  }

  /** TaskCreate's result says the number the new to-do got ("Task #3 created…"). */
  private todoCreated(toolUseId: string, result: string) {
    const todo = this.newTodos.get(toolUseId);
    if (!todo) return;
    this.newTodos.delete(toolUseId);
    todo.id = /#(\d+)/.exec(result)?.[1];
  }

  private paintTodos() {
    this.todosEl.replaceChildren();
    const open = this.todos.filter((t) => t.status !== 'completed').length;
    if (!this.todos.length || !open) return;
    const done = this.todos.length - open;
    const now = this.todos.find((t) => t.status === 'in_progress');
    const head = h('button', 'todos-head');
    head.append(h('span', 'todos-count', `To-dos ${done}/${this.todos.length}`), h('span', 'todos-now', now ? now.activeForm || now.content : ''));
    const list = h('ul', 'todos');
    for (const t of this.todos) list.append(h('li', t.status, t.content));
    list.hidden = this.todosEl.classList.contains('folded');
    head.addEventListener('click', () => {
      this.todosEl.classList.toggle('folded');
      list.hidden = this.todosEl.classList.contains('folded');
    });
    this.todosEl.append(head, list);
  }

  private paintTasks() {
    this.tasksEl.replaceChildren();
    for (const [id, label] of this.bgTasks) {
      const row = h('div', 'bg-task');
      const stop = h('button', 'bg-stop', 'Stop');
      stop.addEventListener('click', () => {
        stop.disabled = true;
        this.host.stopTask(id);
      });
      row.append(h('span', 'tool-dot'), h('span', 'bg-label', label), stop);
      this.tasksEl.append(row);
    }
  }

  private notice(text: string, kind: 'info' | 'error') {
    this.thread.append(h('div', `notice ${kind}`, text));
  }

  private toolRow(id: string, name: string, input: Fields, parent: string | null): ToolRow {
    const existing = this.tools.get(id);
    if (existing) {
      if (Object.keys(input ?? {}).length && !Object.keys(existing.input).length) this.fillTool(existing, input);
      return existing;
    }
    const el = h('div', 'call running');
    const head = h('button', 'tool-head');
    const body = h('div', 'tool-body');
    const sub = h('div', 'tool-sub');
    head.append(h('span', 'tool-dot'), h('span', 'tool-name', toolLabel(name)), h('span', 'tool-detail'));
    el.append(head, sub, body);
    body.hidden = true;
    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
      el.classList.toggle('open', !body.hidden);
    });
    const row: ToolRow = { el, name, input: {}, body, sub, done: false };
    this.tools.set(id, row);
    const parentRow = parent ? this.tools.get(parent) : undefined;
    (parentRow ? parentRow.sub : this.thread).append(el);
    if (input && Object.keys(input).length) this.fillTool(row, input);
    return row;
  }

  private fillTool(row: ToolRow, input: Fields) {
    row.input = input;
    (row.el.querySelector('.tool-detail') as HTMLElement).textContent = toolSummary(row.name, input);
    const shown = toolInputEl(row.name, input);
    if (shown) row.body.prepend(shown);
    // Edits and to-dos are worth seeing without a click.
    if (['Edit', 'MultiEdit'].includes(row.name)) {
      row.body.hidden = false;
      row.el.classList.add('open');
    }
  }

  private toolResult(id: string, content: unknown, isError: boolean) {
    const row = this.tools.get(id);
    if (!row || row.done) return;
    row.done = true;
    row.el.classList.remove('running');
    row.el.classList.toggle('error', isError);
    const text = resultText(content);
    if (row.name === 'Read' && !isError) {
      (row.el.querySelector('.tool-detail') as HTMLElement).textContent += ` · ${lines(text)} lines`;
      return;
    }
    if (['Edit', 'MultiEdit', 'Write', 'TodoWrite'].includes(row.name) && !isError) return;
    if (text.trim()) row.body.append(clipped(text, isError ? 'out error' : 'out'));
    if (isError) {
      row.body.hidden = false;
      row.el.classList.add('open');
    }
  }

  // --- Busy state ------------------------------------------------------------------------------

  setBusy(busy: boolean) {
    if (busy && !this.busy) this.turnStart = Date.now();
    this.busy = busy;
    this.el.classList.toggle('busy', busy);
    this.working.hidden = !busy;
    this.sendBtn.classList.toggle('stop', busy && !this.input.value.trim());
    this.sendBtn.title = busy && !this.input.value.trim() ? 'Stop (Esc)' : 'Send (Enter)';
    clearInterval(this.timer);
    if (busy) {
      const tick = () => {
        const s = Math.floor((Date.now() - this.turnStart) / 1000);
        (this.working.querySelector('.elapsed') as HTMLElement).textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
      };
      tick();
      this.timer = window.setInterval(tick, 1000);
    }
  }

  /** What the session is doing, under the conversation while a turn runs. */
  setActivity(text: string) {
    if (this.asks.size) return;
    (this.working.querySelector('.label') as HTMLElement).textContent = text || 'Working';
  }

  exited(text: string) {
    this.setBusy(false);
    for (const card of this.asks.values()) card.remove();
    this.asks.clear();
    this.notice(text, 'info');
    this.scroll(true);
  }

  error(text: string) {
    this.notice(text, 'error');
    this.scroll(true);
  }

  // --- Asks: permissions, questions, plans -----------------------------------------------------

  ask(a: ChatAsk) {
    const card = h('div', 'ask');
    const reply = (answer: ChatAnswer) => {
      this.host.answer(a.id, answer);
      this.unask(a.id);
      this.focus();
    };
    if (a.tool === 'AskUserQuestion') this.questionCard(card, a, reply);
    else if (a.tool === 'ExitPlanMode') this.planCard(card, a, reply);
    else this.permissionCard(card, a, reply);
    this.asks.set(a.id, card);
    (this.working.querySelector('.label') as HTMLElement).textContent = 'Waiting for you';
    this.asksEl.append(card);
    (card.querySelector('button.primary') as HTMLElement | null)?.focus();
    this.scroll(true);
  }

  unask(id: string) {
    this.asks.get(id)?.remove();
    this.asks.delete(id);
    if (!this.asks.size) (this.working.querySelector('.label') as HTMLElement).textContent = 'Working';
  }

  private permissionCard(card: HTMLElement, a: ChatAsk, reply: (x: ChatAnswer) => void) {
    card.append(h('div', 'ask-title', `Allow ${toolLabel(a.tool)}${toolSummary(a.tool, a.input) ? ` · ${toolSummary(a.tool, a.input)}` : ''}?`));
    if (a.reason) card.append(h('div', 'ask-note', a.reason));
    const shown = toolInputEl(a.tool, a.input);
    if (shown) card.append(shown);
    const buttons = h('div', 'ask-buttons');
    const allow = h('button', 'primary', 'Allow');
    allow.addEventListener('click', () => reply({ allow: true, input: a.input }));
    buttons.append(allow);
    const always = (a.suggestions ?? []).filter((s) => s.type === 'addRules' || s.type === 'setMode' || s.type === 'addDirectories');
    if (always.length) {
      const btn = h('button', undefined, alwaysLabel(always));
      btn.addEventListener('click', () => reply({ allow: true, input: a.input, permissions: always }));
      buttons.append(btn);
    }
    const deny = h('button', 'deny', 'Deny');
    deny.title = 'Deny and tell Claude what to do instead (Esc)';
    deny.addEventListener('click', () => reply({ allow: false, message: 'The user denied this. Wait for their instructions.', interrupt: true }));
    buttons.append(deny);
    card.append(buttons);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') deny.click();
    });
  }

  private questionCard(card: HTMLElement, a: ChatAsk, reply: (x: ChatAnswer) => void) {
    const questions = Array.isArray(a.input.questions) ? (a.input.questions as Fields[]) : [];
    const picks = questions.map(() => new Set<string>());
    const others = questions.map(() => '');
    const submit = h('button', 'primary', 'Answer');
    const refresh = () => (submit.disabled = picks.some((p, i) => !p.size && !others[i].trim()));
    questions.forEach((q, qi) => {
      const multi = Boolean(q.multiSelect);
      const box = h('div', 'question');
      if (str(q, 'header')) box.append(h('div', 'q-header', str(q, 'header')));
      box.append(h('div', 'ask-title', str(q, 'question')));
      const opts = h('div', 'options');
      const buttons: HTMLButtonElement[] = [];
      for (const o of Array.isArray(q.options) ? (q.options as Fields[]) : []) {
        const label = str(o, 'label');
        const b = h('button', 'option');
        b.append(h('span', 'o-label', label));
        if (str(o, 'description')) b.append(h('span', 'o-desc', str(o, 'description')));
        b.addEventListener('click', () => {
          if (!multi) {
            picks[qi].clear();
            for (const x of buttons) x.classList.remove('on');
          }
          if (picks[qi].has(label)) picks[qi].delete(label);
          else picks[qi].add(label);
          b.classList.toggle('on', picks[qi].has(label));
          refresh();
          // One question with one answer to pick goes straight back.
          if (!multi && questions.length === 1) submit.click();
        });
        buttons.push(b);
        opts.append(b);
      }
      const other = h('input', 'other');
      other.placeholder = 'Other…';
      other.addEventListener('input', () => {
        others[qi] = other.value;
        refresh();
      });
      other.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !submit.disabled) submit.click();
      });
      opts.append(other);
      box.append(opts);
      card.append(box);
    });
    const buttons = h('div', 'ask-buttons');
    submit.addEventListener('click', () => {
      const answers: Record<string, string> = {};
      questions.forEach((q, i) => {
        const chosen = [...picks[i], ...(others[i].trim() ? [others[i].trim()] : [])];
        answers[str(q, 'question')] = chosen.join(', ');
      });
      reply({ allow: true, input: { ...a.input, answers } });
    });
    const skip = h('button', 'deny', 'Skip');
    skip.addEventListener('click', () => reply({ allow: false, message: 'The user did not answer. Wait for their instructions.', interrupt: true }));
    buttons.append(submit, skip);
    card.append(buttons);
    refresh();
  }

  private planCard(card: HTMLElement, a: ChatAsk, reply: (x: ChatAnswer) => void) {
    card.classList.add('plan');
    card.append(h('div', 'ask-title', 'Claude has a plan'));
    const plan = h('div', 'md plan-text');
    markdown(plan, str(a.input, 'plan'));
    card.append(plan);
    const note = h('textarea', 'ask-input');
    note.rows = 1;
    note.placeholder = 'Or tell Claude what to change…';
    const buttons = h('div', 'ask-buttons');
    const go = (mode: PermissionMode) => {
      reply({ allow: true, input: a.input });
      this.host.setMode(mode);
      this.setModeShown(mode);
    };
    const accept = h('button', 'primary', 'Approve, accept edits');
    accept.addEventListener('click', () => go('acceptEdits'));
    const manual = h('button', undefined, 'Approve, ask before edits');
    manual.addEventListener('click', () => go('default'));
    const keep = h('button', 'deny', 'Keep planning');
    keep.addEventListener('click', () =>
      reply({ allow: false, message: note.value.trim() ? `The user wants changes to the plan: ${note.value.trim()}` : 'The user wants to keep planning. Wait for their instructions.' }),
    );
    buttons.append(accept, manual, keep);
    card.append(note, buttons);
  }

  // --- Composer --------------------------------------------------------------------------------

  private grow() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 260)}px`;
    this.input.style.overflowY = this.input.scrollHeight > 260 ? 'auto' : 'hidden';
    this.sendBtn.classList.toggle('stop', this.busy && !this.input.value.trim());
  }

  private submit() {
    const text = this.input.value.trim();
    if (!text && !this.images.length) return;
    this.recall = -1;
    if (text.startsWith('!') && !this.images.length) {
      this.input.value = '';
      this.grow();
      return void this.runBash(text.slice(1).trim());
    }
    const uuid = crypto.randomUUID();
    if (text.startsWith('/') && !this.images.length) {
      // Commands stay out of the prompts: Claude Code records them as commands, not as typed text.
      this.thread.append(h('div', 'msg command', text));
    } else {
      const el = this.sent(text, this.images.map((i) => `data:${i.mediaType};base64,${i.data}`));
      if (this.busy) {
        el.classList.add('queued');
        this.queued.set(uuid, el);
      }
    }
    this.host.send(text, this.images, uuid);
    this.input.value = '';
    this.images = [];
    this.shots.replaceChildren();
    this.popup.hidden = true;
    this.grow();
    this.setBusy(true);
    this.scroll(true);
  }

  private async runBash(command: string) {
    if (!command) return;
    const el = this.bashRun(command);
    this.scroll(true);
    const r = await this.host.bash(command);
    const stick = this.atBottom();
    this.bashOutput(el, r.stdout, r.stderr, r.code);
    this.scroll(stick);
  }

  private onKey(e: KeyboardEvent) {
    if (!this.popup.hidden) {
      const items = [...this.popup.children] as HTMLElement[];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.choice = (this.choice + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        this.paintChoice();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && items.length)) {
        e.preventDefault();
        items[this.choice]?.click();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.popup.hidden = true;
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit();
      return;
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      this.cycleMode();
      return;
    }
    if (e.key === 'Escape' && this.busy) {
      e.preventDefault();
      this.host.interrupt();
      return;
    }
    // Esc twice in an empty composer takes the last prompt back, as in Claude Code.
    if (e.key === 'Escape' && !this.input.value) {
      e.preventDefault();
      if (Date.now() - this.lastEsc < 600) {
        this.lastEsc = 0;
        const last = [...this.thread.querySelectorAll<HTMLElement>('.msg.user')].pop();
        if (last) this.editPrompt(last);
      } else this.lastEsc = Date.now();
      return;
    }
    // ↑ at the start of the composer goes back through earlier prompts, ↓ forward again.
    const start = this.input.selectionStart === 0 && this.input.selectionEnd === 0;
    const end = this.input.selectionStart === this.input.value.length;
    if (e.key === 'ArrowUp' && (start || !this.input.value) && this.prompts.length) {
      e.preventDefault();
      if (this.recall < 0) {
        this.draft = this.input.value;
        this.recall = this.prompts.length;
      }
      this.recall = Math.max(0, this.recall - 1);
      this.showRecall();
      return;
    }
    if (e.key === 'ArrowDown' && this.recall >= 0 && end) {
      e.preventDefault();
      this.recall++;
      if (this.recall >= this.prompts.length) {
        this.recall = -1;
        this.input.value = this.draft;
        this.grow();
      } else this.showRecall();
      return;
    }
    if (this.host.key(e)) e.preventDefault();
  }

  private showRecall() {
    this.input.value = this.prompts[this.recall];
    this.grow();
    this.input.setSelectionRange(0, 0);
  }

  /** The completion list: slash commands at the start, files after an `@`. */
  private complete() {
    this.composer.classList.toggle('bash', this.input.value.startsWith('!'));
    const slash = /^\/(\S*)$/.exec(this.input.value);
    if (slash && this.commands.length) {
      const q = slash[1].toLowerCase();
      const hits = this.commands
        .filter((c) => c.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)));
      return this.showChoices(
        hits.slice(0, 50).map((c) => ({ label: `/${c.name}`, detail: c.description, apply: () => this.replaceToken(0, `/${c.name} `) })),
      );
    }
    const before = this.input.value.slice(0, this.input.selectionStart);
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!at) return this.showChoices([]);
    const from = before.length - at[2].length - 1;
    void this.fileChoices(at[2], from);
  }

  private async fileChoices(query: string, from: number) {
    if (!this.fileList || Date.now() - this.fileList.at > 30_000) this.fileList = { at: Date.now(), files: this.host.files() };
    const files = await this.fileList.files;
    // The text may have moved on while the list loaded.
    const before = this.input.value.slice(0, this.input.selectionStart);
    if (!before.endsWith(`@${query}`)) return;
    const q = query.toLowerCase();
    const scored: [number, string][] = [];
    for (const f of files) {
      const lower = f.toLowerCase();
      const i = lower.indexOf(q);
      if (q && i < 0) continue;
      const name = lower.slice(lower.lastIndexOf('/') + 1);
      scored.push([(name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2) * 1000 + f.length, f]);
      if (scored.length > 4000) break;
    }
    scored.sort((a, b) => a[0] - b[0]);
    this.showChoices(scored.slice(0, 50).map(([, f]) => ({ label: base(f), detail: f, apply: () => this.replaceToken(from, `@${f} `) })));
  }

  /** Replaces the text from `from` to the caret with `text`. */
  private replaceToken(from: number, text: string) {
    const caret = this.input.selectionStart;
    this.input.value = this.input.value.slice(0, from) + text + this.input.value.slice(caret);
    const pos = from + text.length;
    this.input.setSelectionRange(pos, pos);
    this.popup.hidden = true;
    this.grow();
    this.input.focus();
  }

  private showChoices(choices: Choice[]) {
    this.choices = choices;
    this.popup.replaceChildren();
    for (const c of choices) {
      const item = h('div', 'slash-item');
      item.append(h('span', 'slash-name', c.label), h('span', 'slash-desc', c.detail));
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => c.apply());
      this.popup.append(item);
    }
    this.choice = 0;
    this.popup.hidden = !choices.length;
    this.paintChoice();
  }

  private paintChoice() {
    [...this.popup.children].forEach((el, i) => el.classList.toggle('on', i === this.choice));
    (this.popup.children[this.choice] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }

  private onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) void this.addImage(f);
  }

  private onDrop(e: DragEvent) {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) void this.addImage(f);
  }

  private async addImage(f: File) {
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type)) return;
    const data = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.readAsDataURL(f);
    });
    const image: ChatImage = { mediaType: f.type as ChatImage['mediaType'], data };
    this.images.push(image);
    const shot = h('div', 'shot');
    const img = h('img');
    img.src = `data:${f.type};base64,${data}`;
    const x = h('button', 'shot-x', '×');
    x.addEventListener('click', () => {
      this.images = this.images.filter((i) => i !== image);
      shot.remove();
    });
    shot.append(img, x);
    this.shots.append(shot);
    this.input.focus();
  }

  private cycleMode() {
    const i = MODES.findIndex((m) => m.mode === this.mode);
    const next = MODES[(i + 1) % MODES.length].mode;
    this.host.setMode(next);
    this.setModeShown(next);
  }

  private setModeShown(mode: PermissionMode) {
    this.mode = mode;
    this.paintMode();
  }

  private paintMode() {
    this.modeBtn.textContent = MODES.find((m) => m.mode === this.mode)?.label ?? this.mode;
    this.modeBtn.className = `mode ${this.mode}`;
  }

  // --- Scrolling -------------------------------------------------------------------------------

  /**
   * The conversation stays at its end while the user is there: as replies stream in, and as the
   * composer, the to-do list or a card above it grows and leaves the conversation less room.
   * Scrolling up lets go of the end; scrolling back down or sending a message takes it again.
   */
  private follow() {
    this.log.addEventListener('scroll', () => (this.pinned = this.atBottom()), { passive: true });
    const keep = () => {
      if (this.pinned) this.log.scrollTop = this.log.scrollHeight;
    };
    const observer = new ResizeObserver(keep);
    observer.observe(this.log);
    observer.observe(this.thread);
    observer.observe(this.working);
  }

  private atBottom() {
    return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60;
  }

  private scroll(stick: boolean) {
    if (!stick) return;
    this.pinned = true;
    this.log.scrollTop = this.log.scrollHeight;
  }
}

function alwaysLabel(updates: PermissionUpdate[]): string {
  const mode = updates.find((u) => u.type === 'setMode');
  if (mode && mode.type === 'setMode' && mode.mode === 'acceptEdits') return 'Allow all edits';
  const rules = updates.flatMap((u) => (u.type === 'addRules' ? u.rules : []));
  if (rules.length === 1 && rules[0].ruleContent) return `Always allow ${rules[0].toolName}(${rules[0].ruleContent.slice(0, 40)})`;
  if (rules.length === 1) return `Always allow ${rules[0].toolName}`;
  return "Don't ask again";
}

/** The images of a user turn, as data URLs. */
function imagesOf(blocks: Block[]): string[] {
  return blocks.flatMap((b) => {
    const src = b.source as Fields | undefined;
    return b.type === 'image' && src?.type === 'base64' ? [`data:${str(src, 'media_type')};base64,${str(src, 'data')}`] : [];
  });
}
