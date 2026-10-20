// --- Chat sessions -----------------------------------------------------------------------------
// A Claude pane is a chat: Liszt drives Claude Code through the Agent SDK instead of running its
// terminal UI. The claude process runs in Liszt's session host (see host.ts), so it keeps working
// after Liszt quits, and the SDK reaches it over the host's socket: a new session is spawned there,
// one still running is attached to again. The pane's hook settings go with it, so the hooks report
// status as they do for a terminal pane. Every message streams to the renderer, which draws the
// conversation, and permission prompts and questions come back through `canUseTool` to wait for the
// user in the pane; one left unanswered when Liszt quit is asked again on attaching.

import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { getSessionInfo, getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk';
import type {
  EffortLevel,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  Query,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions as SdkSpawn,
} from '@anthropic-ai/claude-agent-sdk';
import { promptText } from '../shared/prompts';
import type { ChatAnswer, ChatAsk, ChatImage, ChatInfo, ChatMessage, HostSession, UsageLimit } from '../shared/types';
import { hostClient, type HostClient } from './hostclient';
/** Messages written to a session as the user sends them; the SDK reads them as its prompt stream. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(m: SDKUserMessage) {
    this.queue.push(m);
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

// --- The session host ----------------------------------------------------------------------------

let host: HostClient | null = null;

/** Where the host listens and the script it runs; set once by main. */
export function configureHost(sock: string, script: string) {
  host = hostClient(sock, script);
}

const ask = <T>(req: Record<string, unknown>, timeout?: number) => host!.ask<T>(req, timeout);
const ensureHost = () => host!.ensure();

/** The chat sessions the host runs, by pane; empty when there is no host. */
export async function liveChats(): Promise<HostSession[]> {
  return (await ask<HostSession[]>({ op: 'list' })) ?? [];
}

/**
 * A claude process in the host, as the SDK sees one it spawned: the socket is its stdin and
 * stdout. Killing it only lets go of the socket; ending the session is `kill` to the host.
 */
function hosted(req: Record<string, unknown>): SpawnedProcess & { conn: net.Socket } {
  const conn = net.createConnection(host!.sock);
  const events = new EventEmitter();
  let exitCode: number | null = null;
  conn.on('error', () => {});
  conn.on('close', () => {
    exitCode ??= 0;
    events.emit('exit', exitCode, null);
  });
  conn.write(`${JSON.stringify(req)}\n`);
  return Object.assign(events, {
    conn,
    stdin: conn,
    stdout: conn,
    get killed() {
      return conn.destroyed;
    },
    get exitCode() {
      return exitCode;
    },
    kill() {
      conn.destroy();
      return true;
    },
  }) as unknown as SpawnedProcess & { conn: net.Socket };
}

// --- Chats -------------------------------------------------------------------------------------

interface Ask {
  toolUseId?: string;
  /** The same prompt can come again when a session is attached to anew; one answer settles all. */
  resolve: ((a: PermissionResult) => void)[];
}

interface Chat {
  q: Query;
  inbox: Inbox;
  conn?: net.Socket;
  asks: Map<string, Ask>;
}

export interface ChatStart {
  paneId: string;
  cwd: string;
  claude: string;
  env: Record<string, string>;
  /** The pane's hook settings, as JSON. */
  settings: string;
  sessionId: string;
  resume: boolean;
  prompt?: string;
  appendSystemPrompt?: string;
  /** Resume only up to this transcript entry: a rewind. */
  resumeAt?: string;
}

/** `attached` when the session was still running in the host; `busy` and `asking` say how it is. */
export type ChatStarted = { ok: true; attached: boolean; busy: boolean; asking: boolean; sessionId?: string } | { ok: false; error: string };

const chats = new Map<string, Chat>();
let askSeq = 0;

function userMessage(text: string, images: ChatImage[] = [], extra: Partial<SDKUserMessage> = {}): SDKUserMessage {
  const content = images.length
    ? [
        ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
        { type: 'text' as const, text },
      ]
    : text;
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...extra };
}

/**
 * Starts a pane's session in the host, or attaches to the one still running there; `send` reaches
 * the renderer. Every SDK message goes out as `chat:event`, a prompt for permission as `chat:ask`,
 * and the end of the session as `pty:exit` like a terminal's.
 */
export async function startChat(o: ChatStart, send: (channel: string, ...args: unknown[]) => void): Promise<ChatStarted> {
  detachChat(o.paneId);
  if (!(await ensureHost())) return { ok: false, error: 'Liszt could not start its session host.' };
  let live = (await liveChats()).find((x) => x.id === o.paneId);
  // A new session, or a rewound one, replaces whatever the pane ran before.
  if (live && (!o.resume || o.resumeAt)) {
    await ask({ op: 'kill', id: o.paneId });
    live = undefined;
  }
  const inbox = new Inbox();
  const asks = new Map<string, Ask>();
  const chat: Chat = { q: undefined as unknown as Query, inbox, asks };
  const q = query({
    prompt: inbox,
    options: {
      cwd: o.cwd,
      env: o.env,
      pathToClaudeCodeExecutable: o.claude,
      settings: o.settings,
      includePartialMessages: true,
      // Claude Code's terminal UI starts in auto mode; left out, the SDK starts where `claude -p` does.
      permissionMode: 'auto',
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(o.appendSystemPrompt ? { append: o.appendSystemPrompt } : {}) },
      ...(o.resume ? { resume: o.sessionId, ...(o.resumeAt ? { resumeSessionAt: o.resumeAt } : {}) } : { sessionId: o.sessionId }),
      // Files Claude changes can be put back by a rewind.
      enableFileCheckpointing: true,
      // The chat stops background tasks one at a time, so a Stop ends only the turn.
      perTaskStopAffordance: true,
      // The to-do tools the terminal UI has are off in an SDK session unless named.
      allowedTools: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'],
      // The host keeps the process; what the SDK would run is only its command line for a new one.
      spawnClaudeCodeProcess: (s: SdkSpawn) => {
        const p = live
          ? hosted({ op: 'attach', id: o.paneId })
          : hosted({ op: 'spawn', id: o.paneId, command: s.command, args: s.args, cwd: s.cwd, env: s.env });
        chat.conn = p.conn;
        return p;
      },
      canUseTool: (tool, input, { signal, suggestions, decisionReason, toolUseID }) =>
        new Promise<PermissionResult>((resolve) => {
          const same = toolUseID ? [...asks.values()].find((x) => x.toolUseId === toolUseID) : undefined;
          if (same) {
            same.resolve.push(resolve);
            return;
          }
          const id = String(++askSeq);
          asks.set(id, { toolUseId: toolUseID, resolve: [resolve] });
          signal.addEventListener('abort', () => {
            if (!asks.delete(id)) return;
            send('chat:unask', o.paneId, id);
            resolve({ behavior: 'deny', message: 'Cancelled' });
          });
          const a: ChatAsk = { id, tool, input, suggestions, reason: decisionReason, toolUseId: toolUseID };
          send('chat:ask', o.paneId, a);
        }),
    },
  });
  chat.q = q;
  chats.set(o.paneId, chat);
  if (o.prompt && !live) inbox.push(userMessage(o.prompt));
  // A prompt left waiting when Liszt quit is asked again.
  if (live?.asking) void q.initializationResult().then(() => q.reinitialize()).catch(() => {});

  void (async () => {
    let code = 0;
    try {
      for await (const m of q) {
        if (chats.get(o.paneId) !== chat) return;
        send('chat:event', o.paneId, m);
      }
    } catch (err) {
      code = 1;
      if (chats.get(o.paneId) === chat) send('chat:error', o.paneId, err instanceof Error ? err.message : String(err));
    }
    if (chats.get(o.paneId) !== chat) return;
    chats.delete(o.paneId);
    send('pty:exit', o.paneId, code);
  })();
  return { ok: true, attached: Boolean(live), busy: Boolean(live?.busy), asking: Boolean(live?.asking), sessionId: live?.sessionId };
}

/** `uuid` lets the chat see which reply answers it, so a message sent mid-turn shows queued until then. */
export function sendChat(paneId: string, text: string, images?: ChatImage[], uuid?: string): boolean {
  const chat = chats.get(paneId);
  if (!chat) return false;
  chat.inbox.push(userMessage(text, images, uuid ? { uuid: uuid as SDKUserMessage['uuid'] } : {}));
  return true;
}

/** Adds to the conversation without starting a turn, as a `!` command's input and output are. */
export function appendChat(paneId: string, texts: string[]): boolean {
  const chat = chats.get(paneId);
  if (!chat) return false;
  for (const text of texts) chat.inbox.push(userMessage(text, [], { shouldQuery: false }));
  return true;
}

export async function chatModels(paneId: string): Promise<ModelInfo[]> {
  return (await chats.get(paneId)?.q.supportedModels().catch(() => [])) ?? [];
}

export async function setChatModel(paneId: string, model: string) {
  await chats.get(paneId)?.q.setModel(model).catch(() => {});
}

export async function setChatEffort(paneId: string, effort: EffortLevel) {
  await chats.get(paneId)?.q.applyFlagSettings({ effortLevel: effort }).catch(() => {});
}

export async function stopChatTask(paneId: string, taskId: string) {
  await chats.get(paneId)?.q.stopTask(taskId).catch(() => {});
}

/** `claude-opus-5-5` as people say it: `Opus 5.5`. */
function modelName(id: string): string {
  const [family, ...version] = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
  return [family.charAt(0).toUpperCase() + family.slice(1), version.join('.')].filter(Boolean).join(' ');
}

/** The model, effort, plan and plan usage of a pane's session, for its welcome card. */
export async function chatInfo(paneId: string): Promise<ChatInfo | null> {
  const q = chats.get(paneId)?.q;
  if (!q) return null;
  const [init, settings, usage] = await Promise.all([
    q.initializationResult().catch(() => null),
    // The settings the session runs with; the SDK answers it, though its types leave it out.
    ((q as unknown as { getSettings?: () => Promise<{ applied?: { model?: string; effort?: string | null } }> }).getSettings?.() ?? Promise.resolve(null)).catch(() => null),
    // Experimental in the SDK; the card goes without limits when it fails.
    q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => null),
  ]);
  const id = settings?.applied?.model;
  const limits: UsageLimit[] = [];
  for (const [window, w] of [
    ['5h', usage?.rate_limits?.five_hour],
    ['7d', usage?.rate_limits?.seven_day],
  ] as const) {
    if (typeof w?.utilization === 'number') limits.push({ window, used: w.utilization, resetsAt: w.resets_at ?? undefined });
  }
  return {
    model: id ? (init?.models.find((m: ModelInfo) => m.value === id)?.displayName ?? modelName(id)) : undefined,
    effort: settings?.applied?.effort ?? undefined,
    plan: init?.account.subscriptionType,
    limits,
  };
}

/**
 * Where to resume a session so it forgets the user's `index`th prompt and everything after: the
 * transcript entry just before that prompt, or null to start over when it was the first. With
 * `files`, the files Claude changed since go back to how they were when the prompt was sent.
 */
export async function rewindChat(
  paneId: string,
  sessionId: string,
  cwd: string,
  index: number,
  files: boolean,
): Promise<{ ok: true; resumeAt: string | null; text: string } | { ok: false; error: string }> {
  const messages = (await chatHistory(sessionId, cwd)) as (ChatMessage & { uuid: string })[];
  let seen = -1;
  const at = messages.findIndex((m) => {
    if (m.type !== 'user' || m.parent_tool_use_id) return false;
    if (promptText((m.message as { content?: unknown })?.content) === null) return false;
    return ++seen === index;
  });
  if (at < 0) return { ok: false, error: 'That message is not in the session’s transcript yet.' };
  if (files) {
    const chat = chats.get(paneId);
    if (!chat) return { ok: false, error: 'The session is not running, so its files cannot be put back.' };
    try {
      const r = await chat.q.rewindFiles(messages[at].uuid);
      if (!r.canRewind) return { ok: false, error: r.error || 'Claude Code kept no checkpoint for that message.' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true, resumeAt: at > 0 ? messages[at - 1].uuid : null, text: promptText((messages[at].message as { content?: unknown }).content) ?? '' };
}

export function answerChat(paneId: string, id: string, a: ChatAnswer) {
  const chat = chats.get(paneId);
  const pending = chat?.asks.get(id);
  if (!pending) return;
  chat!.asks.delete(id);
  const result: PermissionResult = a.allow
    ? { behavior: 'allow', updatedInput: a.input, ...(a.permissions ? { updatedPermissions: a.permissions } : {}) }
    : { behavior: 'deny', message: a.message || 'The user said no.', interrupt: a.interrupt };
  for (const resolve of pending.resolve) resolve(result);
}

export async function interruptChat(paneId: string) {
  await chats.get(paneId)?.q.interrupt().catch(() => {});
}

export async function setChatMode(paneId: string, mode: PermissionMode) {
  await chats.get(paneId)?.q.setPermissionMode(mode).catch(() => {});
}

/**
 * Lets go of a pane's session and leaves it running in the host. The socket goes first, so
 * nothing the SDK does on closing (denying the prompts it still holds) reaches the session.
 */
export function detachChat(paneId: string) {
  const chat = chats.get(paneId);
  if (!chat) return;
  chats.delete(paneId);
  chat.conn?.destroy();
  chat.inbox.end();
  chat.q.close();
}

/** Ends a pane's session: the pane closed, restarted or moved it elsewhere. */
export function stopChat(paneId: string) {
  detachChat(paneId);
  void ask({ op: 'kill', id: paneId });
}

/**
 * Ends a pane's session and waits until its process is gone. Another claude that resumes the
 * conversation while it still runs gets a copy of it under a new id, which has no transcript
 * until its first prompt, so the conversation would seem lost.
 */
export async function endChat(paneId: string, timeout = 5000) {
  detachChat(paneId);
  if (!(await ask<{ ok: boolean }>({ op: 'kill', id: paneId }))?.ok) return;
  for (const until = Date.now() + timeout; Date.now() < until; ) {
    if (!(await liveChats()).some((x) => x.id === paneId)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Liszt is quitting: every session goes on in the host. */
export function detachAllChats() {
  for (const id of [...chats.keys()]) detachChat(id);
}

/** The conversation so far, read from its transcript, for a pane that resumes it. */
export async function chatHistory(sessionId: string, cwd: string): Promise<ChatMessage[]> {
  try {
    const messages = await getSessionMessages(sessionId, { dir: cwd });
    // A session started where its folder no longer was is filed under another folder.
    return messages.length ? messages : await getSessionMessages(sessionId);
  } catch {
    return [];
  }
}

/** The name the session was given with /rename. */
export async function chatTitle(sessionId: string, cwd: string): Promise<string | undefined> {
  try {
    return (await getSessionInfo(sessionId, { dir: cwd }))?.customTitle;
  } catch {
    return undefined;
  }
}
