import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { HOST_PROTOCOL } from '../shared/types';
import type {
  AgentSession,
  ChatAnswer,
  ChatImage,
  AppSession,
  AppState,
  BackgroundTask,
  GitInfo,
  GitResult,
  HookEvent,
  MoveResult,
  NotifyKind,
  NotifyPrefs,
  ProjectIcon,
  ProjectKind,
  SpawnOptions,
  SpawnResult,
  TranscriptSession,
  WorktreeResult,
} from '../shared/types';
import {
  answerChat,
  appendChat,
  chatHistory,
  chatModels,
  chatTitle,
  configureHost,
  detachAllChats,
  detachChat,
  interruptChat,
  liveChats,
  rewindChat,
  sendChat,
  setChatEffort,
  setChatMode,
  setChatModel,
  startChat,
  stopChat,
  stopChatTask,
} from './chat';
import { loadNotifyPrefs, notify, notifyPrefs, setNotifyPref } from './notifier';

if (process.env.LISZT_USER_DATA) app.setPath('userData', process.env.LISZT_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

const userData = () => app.getPath('userData');
const statePath = () => path.join(userData(), 'state.json');

let win: BrowserWindow | null = null;
const ptys = new Map<string, pty.IPty>();

function send(channel: string, ...args: unknown[]) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// --- Login shell environment -------------------------------------------------------------------
// Apps started from Finder or the Dock get a bare PATH. Read the login shell's environment once so
// claude, git and whatever Claude runs (fastlane, gradle, unity...) see what a normal terminal sees.

interface ShellEnv {
  env: Record<string, string>;
  claude: string;
}

const MARK = '__LISZT_ENV__';
// Set by a Claude Code session that launched this app (child-session markers, its API proxy, MCP
// sockets). Left in, a pane's claude believes it is a nested child and stops saving transcripts.
// The shell is read without them, so anything the user's own dotfiles export comes back.
const HOST_VARS = /^(CLAUDE|ANTHROPIC_|MCP_)/;
// Terminal identity and shell bookkeeping that belong to whatever launched the app.
const DROP_VARS = ['TERM_PROGRAM_VERSION', 'ITERM_SESSION_ID', 'VSCODE_INJECTION', 'PWD', 'OLDPWD', 'SHLVL', '_'];

function readShellEnv(): Promise<ShellEnv> {
  const shellPath = process.env.SHELL || '/bin/zsh';
  const script = `printf '${MARK}%s${MARK}' "$(command -v claude)"; env -0`;
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOST_VARS.test(k)) base[k] = v;
  return new Promise((resolve) => {
    execFile(shellPath, ['-l', '-i', '-c', script], { env: base, encoding: 'utf8', timeout: 8000, maxBuffer: 8 << 20 }, (_err, stdout) => {
      const env = { ...base };
      let claude = 'claude';
      const start = stdout ? stdout.indexOf(MARK) : -1;
      const end = start >= 0 ? stdout.indexOf(MARK, start + MARK.length) : -1;
      if (end > start) {
        claude = stdout.slice(start + MARK.length, end).trim() || 'claude';
        for (const entry of stdout.slice(end + MARK.length).split('\0')) {
          const eq = entry.indexOf('=');
          if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
      }
      for (const k of DROP_VARS) delete env[k];
      resolve({ env, claude });
    });
  });
}

const shellEnv = readShellEnv();

// --- Claude Code hooks -------------------------------------------------------------------------
// Each claude pane is started with `--settings <json>` holding these hooks, with the pane id written
// into the command: Claude Code's background server runs every session with the environment the
// server itself started with, so a pane's environment never reaches its session. Every hook posts
// its JSON payload to a loopback server whose address it reads from a file when it fires, so a
// session started before Liszt last quit reports to the Liszt running now. A random token in that
// address keeps other local processes from faking events. The output is discarded so nothing leaks
// into Claude's context, and a failure never blocks Claude.

const hookUrlFile = () => path.join(userData(), 'hook-url');
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function hookSettings(paneId: string, allow: string[] = []): string {
  const command =
    `curl -s -m 2 --noproxy '*' -H 'Content-Type: application/json' ` +
    `--data-binary @- "$(cat ${shellQuote(hookUrlFile())} 2>/dev/null)&pane=${paneId}" >/dev/null 2>&1 || true`;
  const entry = [{ hooks: [{ type: 'command', command }] }];
  const toolEntry = [{ matcher: '*', hooks: [{ type: 'command', command }] }];
  return JSON.stringify({
    hooks: {
      SessionStart: entry,
      UserPromptSubmit: entry,
      Notification: entry,
      Stop: entry,
      SessionEnd: entry,
      PostToolUse: toolEntry,
    },
    // Every pane is a background session, and Claude Code would otherwise keep it out of the
    // project's own checkout until it moves into a worktree.
    worktree: { bgIsolation: 'none' },
    ...(allow.length ? { permissions: { allow } } : {}),
  });
}

/**
 * The settings file earlier versions started panes with. Background sessions made from those panes
 * name it in the flags Claude Code wakes them with, so it stays; its hooks read a pane id and an
 * address from an environment the background server does not have, and send nothing.
 */
function writeClaudeSettings() {
  const command =
    `curl -s -m 2 --noproxy '*' -H 'Content-Type: application/json' ` +
    `--data-binary @- "$LISZT_HOOK_URL&pane=$LISZT_PANE_ID" >/dev/null 2>&1 || true`;
  const entry = [{ hooks: [{ type: 'command', command }] }];
  const toolEntry = [{ matcher: '*', hooks: [{ type: 'command', command }] }];
  const settings = {
    hooks: {
      SessionStart: entry,
      UserPromptSubmit: entry,
      Notification: entry,
      Stop: entry,
      SessionEnd: entry,
      PostToolUse: toolEntry,
    },
  };
  fs.writeFileSync(path.join(userData(), 'claude-settings.json'), JSON.stringify(settings, null, 2));
}

function startHookServer(): Promise<string> {
  const token = randomBytes(16).toString('hex');
  const server = http.createServer((req, res) => {
    const params = new URL(req.url ?? '/', 'http://liszt').searchParams;
    const paneId = params.get('pane');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (paneId && params.get('token') === token && params.has('move')) {
        res.end(moveRequest(paneId, params.get('move') ?? ''));
        return;
      }
      res.end();
      if (!paneId || params.get('token') !== token) return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return;
      }
      const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : undefined);
      const ev: HookEvent = {
        paneId,
        event: str('hook_event_name') ?? '',
        sessionId: str('session_id'),
        transcriptPath: str('transcript_path'),
        source: str('source'),
        prompt: str('prompt'),
        message: str('message'),
        tool: str('tool_name'),
        detail: toolDetail(payload.tool_input),
        command: bashCommand(payload.tool_name, payload.tool_input),
        tasks: runningTasks(payload.background_tasks),
      };
      if (process.env.LISZT_DEBUG) console.log('[hook]', paneId, ev.event, ev.source ?? '');
      send('hook', ev);
      // A prompt typed during the turn may start the next one now, which no hook announces and only
      // the agents list shows; ask for it once Claude Code's busy flag has settled.
      if (ev.event === 'Stop') setTimeout(() => void pollAgents(), AGENTS_AFTER_STOP);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      const url = `http://127.0.0.1:${port}/hook?token=${token}`;
      // Only this user may read the token.
      fs.writeFileSync(hookUrlFile(), url, { mode: 0o600 });
      fs.chmodSync(hookUrlFile(), 0o600);
      resolve(url);
    });
  });
}

let hookUrl: Promise<string> = new Promise(() => {});

/**
 * The background tasks a Stop hook lists as still going. Claude ended its turn but starts another
 * when each one finishes, so the session is not done yet.
 */
function runningTasks(raw: unknown): BackgroundTask[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tasks: BackgroundTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const fields = item as Record<string, unknown>;
    if (fields.status !== 'running' && fields.status !== 'pending') continue;
    const str = (k: string) => (typeof fields[k] === 'string' ? (fields[k] as string) : '');
    const label = str('description') || str('command').split('\n')[0] || 'Background task';
    tasks.push({ type: str('type'), label: label.slice(0, 80) });
  }
  return tasks;
}

/** What a tool call touched, short enough for one line: a file name, a command, a pattern. */
function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const fields = input as Record<string, unknown>;
  const str = (k: string) => (typeof fields[k] === 'string' ? (fields[k] as string) : '');
  const file = str('file_path') || str('notebook_path');
  if (file) return path.basename(file);
  const text = str('command') || str('pattern') || str('description') || str('url') || str('query') || str('path');
  return text ? text.split('\n')[0].slice(0, 80) : undefined;
}

/** The whole command of a Bash call, so a push or a merge in a chain of commands is still seen. */
function bashCommand(tool: unknown, input: unknown): string | undefined {
  if (tool !== 'Bash' || !input || typeof input !== 'object') return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === 'string' ? command.slice(0, 2000) : undefined;
}

// --- New projects ------------------------------------------------------------------------------
// New Project opens a Claude session in ~/other-projects to work out a new project with the user.
// Its system prompt tells Claude where project folders live (every ~/*-projects folder) and how to
// hand the session over once it has made one: a script asks Liszt, through the hook server, to move
// the session there. Liszt does it when the turn ends, since a session cannot change folder while it
// runs: it stops the session, moves its transcript to the new folder and resumes it there.

const incubatorDir = () => path.join(os.homedir(), 'other-projects');
const moveScript = () => path.join(userData(), 'liszt-move');

/** The folders projects are kept in: ~/other-projects, ~/chaos-projects, ~/unity-projects… */
function projectRoots(): string[] {
  const home = os.homedir();
  const roots = fs
    .readdirSync(home, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith('-projects'))
    .map((d) => path.join(home, d.name));
  return roots.includes(incubatorDir()) ? roots : [incubatorDir(), ...roots];
}

/** The move script and its pane, as Claude runs it and its permission rule matches it. */
const moveCommand = (paneId: string) => `${shellQuote(moveScript())} ${paneId}`;

function writeMoveScript() {
  const script = `#!/bin/sh
# Asks Liszt to move this New Project session into its project's folder: liszt-move <pane> <folder>
dir=$(cd "$2" 2>/dev/null && pwd -P) || { echo "No such folder: $2" >&2; exit 1; }
url=$(cat ${shellQuote(hookUrlFile())} 2>/dev/null) || { echo "Liszt is not running." >&2; exit 1; }
reply=$(curl -s -m 5 --noproxy '*' -G --data-urlencode "pane=$1" --data-urlencode "move=$dir" "$url") || { echo "Liszt did not answer." >&2; exit 1; }
echo "$reply"
case $reply in Moving*) ;; *) exit 1 ;; esac
`;
  fs.writeFileSync(moveScript(), script, { mode: 0o755 });
  fs.chmodSync(moveScript(), 0o755);
}

function newProjectPrompt(paneId: string): string {
  const home = os.homedir();
  const roots = projectRoots().map((r) => `~/${path.relative(home, r)}`);
  return [
    `This session was opened from Liszt's New Project button to start a new project with the user. It runs in ~/${path.relative(home, incubatorDir())}, which only holds project folders and is not the new project's home.`,
    `Project folders live in: ${roots.join(', ')}.`,
    `Work out with the user what the project is. Once it can be named, choose a short kebab-case folder name and the folder it belongs in (ask the user when the right one is not obvious), create the project's folder there, then run:`,
    `${moveCommand(paneId)} <the new folder>`,
    `It confirms the request. End your turn right after with a short note: Liszt then moves this conversation into the new folder and opens it in a project tab of its own, where the work goes on. Do not build the project before the move.`,
    `Once your working directory is that new folder, the move is done and these instructions no longer apply.`,
  ].join('\n');
}

/** Answers the move script; the renderer moves the session when its turn ends. */
function moveRequest(paneId: string, dir: string): string {
  if (!PANE_ID.test(paneId)) return `Not a Liszt pane: ${paneId}`;
  let real: string;
  try {
    real = fs.realpathSync(dir);
    if (!fs.statSync(real).isDirectory()) return `Not a folder: ${dir}`;
  } catch {
    return `No such folder: ${dir}`;
  }
  const roots = projectRoots().map((r) => (fs.existsSync(r) ? fs.realpathSync(r) : r));
  if (!roots.some((r) => real.startsWith(`${r}/`))) return `Not inside a projects folder (${roots.join(', ')}): ${real}`;
  send('move-request', paneId, real);
  return `Moving this session to ${real} when this turn ends.`;
}

ipcMain.handle('projects:incubator', () => {
  fs.mkdirSync(incubatorDir(), { recursive: true });
  return incubatorDir();
});

// --- Terminals ---------------------------------------------------------------------------------
// A shell pane runs the login shell in a pty. A Claude pane is a chat by default: its session runs
// in Liszt's session host (see chat.ts), so it keeps working after Liszt quits and is attached to
// again on the next start. Switched to the terminal, it runs a Claude Code background session
// instead: `claude --bg` starts it on Claude Code's background server and the pane's terminal runs
// `claude attach` on it, which also outlives Liszt. Only one of them runs the session at a time, so
// switching stops the one and resumes the conversation in the other. Where no background session
// can start (Claude Code refuses folders it does not trust yet) the terminal runs claude itself,
// which asks about trust and ends with the app.

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const BACKGROUNDED = /backgrounded\W+([0-9a-f]{8})\b/;
/** A chat asked to take over a background session that is still working. */
const BUSY_IN_BACKGROUND = 'busy-in-background';
// Pane ids are written into hook commands.
const PANE_ID = /^[\w-]+$/;

// Bumped by every spawn and kill, so a start that waited on claude can tell its pane was closed or restarted.
const spawnSeq = new Map<string, number>();
function nextSpawn(paneId: string): number {
  const n = (spawnSeq.get(paneId) ?? 0) + 1;
  spawnSeq.set(paneId, n);
  return n;
}

/** Claude Code records a session's system prompt on its first request and reuses it on every resume. */
const newProjectArgs = (o: SpawnOptions, resume: boolean) =>
  o.newProject && !resume ? ['--append-system-prompt', newProjectPrompt(o.paneId)] : [];

/** Auto mode's permission check reads moving a session's transcript as tampering, so the move script is allowed outright. */
const paneSettings = (o: SpawnOptions) => hookSettings(o.paneId, o.newProject ? [`Bash(${moveCommand(o.paneId)} *)`] : []);

/** Starts a background session for a pane; null when Claude Code would not. */
async function startBackground(o: SpawnOptions, resume: boolean, sessionId: string, cwd: string): Promise<{ bgId: string; sessionId: string } | null> {
  const args = ['--bg', '--settings', paneSettings(o), ...newProjectArgs(o, resume)];
  // A resumed session keeps its id.
  if (resume) args.push('--resume', sessionId);
  // `--` keeps a prompt that starts with a dash from being read as an option.
  else if (o.prompt) args.push('--', o.prompt);
  let out: string;
  try {
    // The first one also starts the background server, which can take a while.
    out = await runClaude(args, 30_000, cwd);
  } catch (err) {
    if (process.env.LISZT_DEBUG) console.log('[bg] not started:', errorText(err));
    return null;
  }
  const bgId = BACKGROUNDED.exec(out.replace(ANSI, ''))?.[1];
  if (!bgId) return null;
  // Claude Code picks the id of a new session, and of a copy when the resumed one runs elsewhere.
  const job = await readJson(path.join(await claudeDir(), 'jobs', bgId, 'state.json'));
  const listed = (job as { sessionId?: unknown } | undefined)?.sessionId;
  const id = typeof listed === 'string' ? listed : (await listAgents())?.find((a) => a.id === bgId)?.sessionId;
  return { bgId, sessionId: id ?? sessionId };
}

/** Stops the background session a pane ran in the terminal, so the chat can resume its conversation. */
async function releaseBackground(sessionId: string, bgId?: string) {
  const jobs = (await listAgents())?.filter((a) => a.kind === 'background' && a.id && !a.ended && (a.sessionId === sessionId || a.id === bgId));
  for (const job of jobs ?? []) await runClaude(['stop', job.id!]).catch(() => {});
}

ipcMain.handle('pty:spawn', async (_e, o: SpawnOptions): Promise<SpawnResult> => {
  if (!PANE_ID.test(o.paneId)) return { ok: false, error: `Not a pane id: ${o.paneId}` };
  const seq = nextSpawn(o.paneId);
  const { env, claude } = await shellEnv;
  // The hooks read the server's address from its file, so a session must not start before it is written.
  await hookUrl;
  const old = ptys.get(o.paneId);
  ptys.delete(o.paneId);
  old?.kill();
  // A chat still running in the host is attached to again rather than started anew.
  detachChat(o.paneId);

  const paneEnv: Record<string, string> = {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Liszt',
  };
  paneEnv.LANG ||= 'en_US.UTF-8';
  const cwd = fs.existsSync(o.cwd) ? o.cwd : os.homedir();
  let { resume, sessionId } = o;

  if (o.kind === 'claude' && !o.terminal) {
    if (resume && o.attach) {
      // A background session still at work is left to it; the pane shows it in the terminal.
      const job = (await listAgents())?.find((a) => a.kind === 'background' && a.id === o.attach && !a.ended);
      if (job && job.status !== 'idle') return { ok: false, error: BUSY_IN_BACKGROUND };
      await releaseBackground(sessionId, o.attach);
    }
    // Claude cleans up old transcripts; a resume of one that is gone fails, so start a new session instead.
    if (resume && o.transcript && !fs.existsSync(o.transcript)) {
      resume = false;
      sessionId = randomUUID();
    }
    if (spawnSeq.get(o.paneId) !== seq) return { ok: false, error: 'The pane was closed or restarted while it started.' };
    const started = await startChat(
      {
        paneId: o.paneId,
        cwd,
        claude,
        env: paneEnv,
        settings: paneSettings(o),
        sessionId,
        resume,
        prompt: resume ? undefined : o.prompt,
        appendSystemPrompt: o.newProject && !resume ? newProjectPrompt(o.paneId) : undefined,
        resumeAt: resume ? o.resumeAt : undefined,
      },
      send,
    );
    if (!started.ok) return started;
    return { ok: true, sessionId: started.sessionId ?? sessionId, resumed: resume || started.attached, live: started };
  }

  // A background session is attached while Claude Code still knows it, even done or stopped:
  // attach wakes it on the conversation it last had, whereas the listed session id is the one it
  // started with, from before any /clear. Once it is removed it is resumed by session id.
  let bgId =
    o.kind === 'claude' && o.attach && (await listAgents())?.some((a) => a.kind === 'background' && a.id === o.attach)
      ? o.attach
      : undefined;
  // Claude cleans up old transcripts; resuming one that is gone lands in its session picker, so
  // start a new session instead.
  if (!bgId && resume && o.transcript && !fs.existsSync(o.transcript)) {
    resume = false;
    sessionId = randomUUID();
  }
  // Started here, so stopped again if the pane goes away before it is attached.
  let started: string | undefined;
  if (o.kind === 'claude' && !bgId) {
    const bg = await startBackground(o, resume, sessionId, cwd);
    if (bg) ({ bgId, sessionId } = bg);
    started = bg?.bgId;
  }
  const abandon = async (error: string): Promise<SpawnResult> => {
    if (started) await runClaude(['stop', started]).catch(() => {});
    return { ok: false, error };
  };
  if (spawnSeq.get(o.paneId) !== seq) return abandon('The pane was closed or restarted while it started.');

  const [file, args] =
    o.kind !== 'claude'
      ? [env.SHELL || '/bin/zsh', ['-l']]
      : bgId
        ? [claude, ['attach', bgId]]
        : [claude, ['--settings', paneSettings(o), ...newProjectArgs(o, resume), resume ? '--resume' : '--session-id', sessionId]];
  if (o.kind === 'claude' && !bgId && o.prompt && !resume) args.push('--', o.prompt);

  let p: pty.IPty;
  try {
    p = pty.spawn(file, args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd, env: paneEnv });
  } catch (err) {
    return abandon(String(err));
  }
  ptys.set(o.paneId, p);
  // `/background` hands the conversation to Claude Code's background server under a new session id
  // and prints the short id before exiting; that line is the only link back to this pane.
  let tail = '';
  // A restarted pane reuses its id, so ignore anything the replaced process still emits.
  p.onData((data) => {
    if (ptys.get(o.paneId) !== p) return;
    send('pty:data', o.paneId, data);
    if (o.kind !== 'claude' || bgId) return;
    tail = (tail + data.replace(ANSI, '')).slice(-300);
    const m = BACKGROUNDED.exec(tail);
    if (!m) return;
    tail = '';
    send('pty:background', o.paneId, m[1]);
  });
  p.onExit(({ exitCode }) => {
    if (ptys.get(o.paneId) !== p) return;
    ptys.delete(o.paneId);
    send('pty:exit', o.paneId, exitCode);
  });
  return { ok: true, sessionId, resumed: resume, bgId };
});

ipcMain.on('chat:send', (_e, id: string, text: string, images?: ChatImage[], uuid?: string) => sendChat(id, text, images, uuid));
ipcMain.handle('chat:models', (_e, id: string) => chatModels(id));
ipcMain.on('chat:model', (_e, id: string, model: string) => void setChatModel(id, model));
ipcMain.on('chat:effort', (_e, id: string, effort: EffortLevel) => void setChatEffort(id, effort));
ipcMain.on('chat:stop-task', (_e, id: string, taskId: string) => void stopChatTask(id, taskId));
ipcMain.handle('chat:rewind', (_e, id: string, sessionId: string, cwd: string, index: number, files: boolean) => rewindChat(id, sessionId, cwd, index, files));
ipcMain.handle('chat:bash', (_e, id: string, cwd: string, command: string) => runBash(id, cwd, command));
ipcMain.handle('chat:files', (_e, cwd: string) => projectFiles(cwd));

// --- `!` commands and `@` mentions --------------------------------------------------------------

/** What a `!` command may print into the conversation; the rest is cut. */
const BASH_KEEP = 30_000;

/**
 * Runs a `!` command in the pane's folder with the login shell's environment, as Claude Code's
 * terminal UI does, and adds the command and its output to the conversation without a turn, so
 * Claude sees them with the next prompt.
 */
async function runBash(paneId: string, cwd: string, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const { env } = await shellEnv;
  const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) =>
    execFile(env.SHELL || '/bin/zsh', ['-c', command], { cwd: fs.existsSync(cwd) ? cwd : os.homedir(), env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
      resolve({ stdout: stdout ?? '', stderr: stderr || (err && !stdout ? err.message : ''), code: typeof err?.code === 'number' ? err.code : err ? 1 : 0 }),
    ),
  );
  const cut = (s: string) => (s.length > BASH_KEEP ? `${s.slice(0, BASH_KEEP)}\n… (${s.length - BASH_KEEP} more characters)` : s);
  appendChat(paneId, [
    `<bash-input>${command}</bash-input>`,
    `<bash-stdout>${cut(result.stdout.trimEnd())}</bash-stdout><bash-stderr>${cut(result.stderr.trimEnd())}</bash-stderr>`,
  ]);
  return result;
}

const fileLists = new Map<string, { at: number; files: Promise<string[]> }>();

/** The files `@` offers: what git tracks or would, else a shallow walk; kept for half a minute. */
function projectFiles(cwd: string): Promise<string[]> {
  const cached = fileLists.get(cwd);
  if (cached && Date.now() - cached.at < 30_000) return cached.files;
  const files = new Promise<string[]>((resolve) =>
    execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd, encoding: 'utf8', maxBuffer: 32 << 20 }, (err, out) => {
      if (!err) return resolve(out.split('\n').filter(Boolean).slice(0, 50_000));
      const found: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 4 || found.length > 5000) return;
        for (const d of fs.readdirSync(path.join(cwd, dir), { withFileTypes: true })) {
          if (d.name.startsWith('.') || d.name === 'node_modules') continue;
          const rel = dir ? `${dir}/${d.name}` : d.name;
          if (d.isDirectory()) walk(rel, depth + 1);
          else found.push(rel);
        }
      };
      try {
        walk('', 0);
      } catch {
        // An unreadable folder offers nothing.
      }
      resolve(found);
    }),
  );
  fileLists.set(cwd, { at: Date.now(), files });
  return files;
}
ipcMain.on('chat:answer', (_e, id: string, askId: string, a: ChatAnswer) => answerChat(id, askId, a));
ipcMain.on('chat:interrupt', (_e, id: string) => void interruptChat(id));
ipcMain.on('chat:mode', (_e, id: string, mode: PermissionMode) => void setChatMode(id, mode));
ipcMain.handle('chat:history', (_e, sessionId: string, cwd: string) => chatHistory(sessionId, cwd));
ipcMain.handle('chat:title', (_e, sessionId: string, cwd: string) => chatTitle(sessionId, cwd));
ipcMain.handle('chat:live', () => liveChats());

ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.get(id)?.write(data));

ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
  try {
    ptys.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 1));
  } catch {
    // The process may have exited between the renderer's measure and this call.
  }
});

ipcMain.on('pty:kill', (_e, id: string) => {
  nextSpawn(id);
  stopChat(id);
  const p = ptys.get(id);
  ptys.delete(id);
  p?.kill();
});

// --- Claude sessions on this machine -----------------------------------------------------------
// `claude agents --json --all` lists every Claude Code session on the machine: the running ones,
// interactive or background, and the background ones that finished or were stopped. The renderer
// shows the ones outside Liszt, and stops a closed pane's session when Claude Code's background
// server (`--bg-pty-host`) runs it: `/background` in a pane, or a pane attached to one. Those outlive
// the pane's process.

const AGENTS_INTERVAL = 10_000;
/** Past the renderer's STOP_SETTLE, so the list counts. */
const AGENTS_AFTER_STOP = 3000;

function parseAgents(raw: unknown): AgentSession[] {
  if (!Array.isArray(raw)) return [];
  const list: AgentSession[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const fields = item as Record<string, unknown>;
    const str = (k: string) => (typeof fields[k] === 'string' ? (fields[k] as string) : undefined);
    const sessionId = str('sessionId');
    const cwd = str('cwd');
    if (!sessionId || !cwd) continue;
    const background = fields.kind === 'background';
    const state = str('state');
    list.push({
      sessionId,
      id: background ? str('id') : undefined,
      pid: !background && typeof fields.pid === 'number' ? fields.pid : undefined,
      kind: background ? 'background' : 'interactive',
      name: str('name') ?? '',
      cwd,
      status: fields.status === 'busy' || fields.status === 'waiting' ? fields.status : 'idle',
      state,
      // The same test Claude Code uses to leave a session out unless `--all` is given.
      ended: background && fields.pid === undefined && state !== 'working' && state !== 'blocked',
      startedAt: typeof fields.startedAt === 'number' ? fields.startedAt : Date.now(),
    });
  }
  return list;
}

/** Claude Code's own folder: transcripts under projects/, background sessions under jobs/. */
async function claudeDir(): Promise<string> {
  return (await shellEnv).env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readDir(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

/** Null when claude could not be asked, so a failed run never reads as "no sessions". */
async function listAgents(): Promise<AgentSession[] | null> {
  const { env, claude } = await shellEnv;
  const out = await new Promise<string | null>((resolve) =>
    execFile(claude, ['agents', '--json', '--all'], { env, encoding: 'utf8', timeout: 8000, maxBuffer: 8 << 20 }, (err, stdout) =>
      resolve(err ? null : stdout),
    ),
  );
  if (out === null) return null;
  let list: AgentSession[];
  try {
    list = parseAgents(JSON.parse(out));
  } catch {
    return null;
  }
  // The agent view pins background sessions by short id.
  const pins = await readJson(path.join(await claudeDir(), 'jobs', 'pins.json'));
  if (Array.isArray(pins)) for (const a of list) a.pinned = Boolean(a.id && pins.includes(a.id));
  return list;
}

// --- Claude app sessions -----------------------------------------------------------------------
// The Claude desktop app keeps a file per Claude Code session it ran, archived ones included, in
// claude-code-sessions/<account>/<org>/local_<id>.json, and lists the pinned ones in its
// preferences. Liszt only reads them: any of them opens with `claude --resume <cliSessionId>`.

interface AppSessionFile {
  id: string;
  sessionId: string;
  title: string;
  cwd: string;
  originCwd?: string;
  archived: boolean;
  lastActivityAt: number;
}

// Session files carry tool schemas and run to hundreds of KB, so each is parsed once per change.
const appSessionFiles = new Map<string, { mtimeMs: number; session: AppSessionFile | null }>();

async function readAppSessionFile(file: string): Promise<AppSessionFile | null> {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat) return null;
  const cached = appSessionFiles.get(file);
  if (cached?.mtimeMs === stat.mtimeMs) return cached.session;
  const raw = await readJson(file);
  const fields = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const str = (k: string) => (typeof fields[k] === 'string' ? (fields[k] as string) : undefined);
  const id = str('sessionId');
  const sessionId = str('cliSessionId');
  const cwd = str('cwd');
  const session: AppSessionFile | null =
    id && sessionId && cwd
      ? {
          id,
          sessionId,
          title: str('title') || 'Untitled',
          cwd,
          originCwd: str('originCwd'),
          archived: fields.isArchived === true,
          lastActivityAt: typeof fields.lastActivityAt === 'number' ? fields.lastActivityAt : stat.mtimeMs,
        }
      : null;
  appSessionFiles.set(file, { mtimeMs: stat.mtimeMs, session });
  return session;
}

/** Ids the app's sidebar pins. The format is the app's own, so every string in those lists counts. */
async function appPins(appDir: string): Promise<Set<string>> {
  const config = await readJson(path.join(appDir, 'claude_desktop_config.json'));
  const prefs = (config as { preferences?: { epitaxyPrefs?: Record<string, unknown> } } | undefined)?.preferences?.epitaxyPrefs ?? {};
  const ids = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === 'string') ids.add(v.replace(/^local_/, ''));
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(prefs['starred-local-code-sessions']);
  collect((prefs['dframe-local-slice'] as { pinnedOrder?: unknown } | undefined)?.pinnedOrder);
  return ids;
}

/** Session ids that still have a transcript; Claude Code deletes old ones. */
async function transcriptIds(): Promise<Set<string>> {
  const root = path.join(await claudeDir(), 'projects');
  const ids = new Set<string>();
  for (const dir of await readDir(root)) {
    for (const name of await readDir(path.join(root, dir))) if (name.endsWith('.jsonl')) ids.add(name.slice(0, -'.jsonl'.length));
  }
  return ids;
}

async function listAppSessions(): Promise<AppSession[]> {
  const appDir = path.join(app.getPath('appData'), 'Claude');
  const root = path.join(appDir, 'claude-code-sessions');
  const files: string[] = [];
  for (const account of await readDir(root)) {
    for (const org of await readDir(path.join(root, account))) {
      for (const name of await readDir(path.join(root, account, org))) {
        if (name.startsWith('local_') && name.endsWith('.json')) files.push(path.join(root, account, org, name));
      }
    }
  }
  for (const file of appSessionFiles.keys()) if (!files.includes(file)) appSessionFiles.delete(file);
  const [pins, transcripts] = await Promise.all([appPins(appDir), transcriptIds()]);
  const list: AppSession[] = [];
  for (const file of files) {
    const s = await readAppSessionFile(file);
    if (!s) continue;
    const cwd = [s.cwd, s.originCwd].find((dir) => dir && fs.existsSync(dir));
    list.push({
      id: s.id,
      sessionId: s.sessionId,
      title: s.title,
      cwd: cwd ?? s.cwd,
      archived: s.archived,
      pinned: pins.has(s.id.replace(/^local_/, '')) || pins.has(s.sessionId),
      lastActivityAt: s.lastActivityAt,
      gone: !cwd ? 'folder' : !transcripts.has(s.sessionId) ? 'transcript' : undefined,
    });
  }
  return list;
}

// --- Claude Code transcripts -------------------------------------------------------------------
// Claude Code keeps a transcript of every session it runs in projects/<folder>/<id>.jsonl until it
// cleans old ones up, whatever started the session: a terminal, the Claude app, the Agent SDK or a
// Liszt pane. It is the only trace of a session nothing else lists, such as one that ran in a
// terminal and ended. Transcripts run to tens of MB, so only their two ends are read, once per
// change: the head has the first prompt, and Claude Code keeps appending the session's title and
// last prompt so that its own session list finds them in the tail.

/** How much of each end of a transcript is read. */
const TRANSCRIPT_END = 64 * 1024;

const transcriptFiles = new Map<string, { mtimeMs: number; size: number; session: TranscriptSession | null }>();

/** The folder under projects/ that Claude Code files a session started in `cwd` under. */
const projectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** The records of a chunk of a transcript; the lines it cuts off at either end do not parse and are skipped. */
function records(text: string): Record<string, unknown>[] {
  const list: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      list.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Cut off.
    }
  }
  return list;
}

/** A prompt on one line: `/command args` for a slash command, nothing for what Claude Code adds itself. */
function promptText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((b: { type?: unknown; text?: unknown }) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(' ')
        : '';
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  const line = command ? `${command[1]} ${/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ''}` : text.trimStart().startsWith('<') ? '' : text;
  return line.replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function readTranscript(file: string): Promise<TranscriptSession | null> {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat) return null;
  const cached = transcriptFiles.get(file);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.session;
  let head = '';
  let tail = '';
  try {
    const fh = await fs.promises.open(file, 'r');
    try {
      const read = async (at: number, length: number) => {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, at);
        return buf.toString('utf8', 0, bytesRead);
      };
      head = await read(0, Math.min(stat.size, TRANSCRIPT_END));
      if (stat.size > TRANSCRIPT_END) {
        const from = Math.max(TRANSCRIPT_END, stat.size - TRANSCRIPT_END);
        tail = await read(from, stat.size - from);
      }
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  const first = records(head);
  const all = [...first, ...records(tail)];
  const str = (r: Record<string, unknown>, k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
  // A session that went into a worktree goes on recording the worktree as its folder.
  const cwds: string[] = [];
  let entrypoint = '';
  let customTitle = '';
  let aiTitle = '';
  let agentName = '';
  let lastPrompt = '';
  for (const r of all) {
    if (str(r, 'cwd')) cwds.push(str(r, 'cwd'));
    const original = (r.worktreeSession as { originalCwd?: unknown } | undefined)?.originalCwd;
    if (typeof original === 'string') cwds.push(original);
    entrypoint ||= str(r, 'entrypoint');
    // Appended again as they change, so the last one counts.
    customTitle = str(r, 'customTitle') || customTitle;
    aiTitle = str(r, 'aiTitle') || aiTitle;
    agentName = str(r, 'agentName') || agentName;
    lastPrompt = (r.type === 'last-prompt' && promptText({ content: r.lastPrompt })) || lastPrompt;
  }
  let firstPrompt = '';
  for (const r of first) {
    if (r.type === 'user' && !r.isMeta && !r.isSidechain) firstPrompt = promptText(r.message);
    if (firstPrompt) break;
  }
  const folder = path.basename(path.dirname(file));
  const cwd = cwds.find((dir) => projectFolder(dir) === folder) ?? cwds[0];
  const title = customTitle || aiTitle || agentName || firstPrompt || lastPrompt;
  // Without a folder or a single prompt there is nothing to resume; a subagent's transcript is not a session.
  const session: TranscriptSession | null =
    cwd && title && first.find((r) => 'isSidechain' in r)?.isSidechain !== true
      ? {
          sessionId: path.basename(file, '.jsonl'),
          title,
          cwd,
          entrypoint: entrypoint || undefined,
          lastActivityAt: stat.mtimeMs,
        }
      : null;
  transcriptFiles.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, session });
  return session;
}

async function listTranscriptSessions(): Promise<TranscriptSession[]> {
  const root = path.join(await claudeDir(), 'projects');
  const files = new Set<string>();
  for (const dir of await readDir(root)) {
    for (const name of await readDir(path.join(root, dir))) {
      if (name.endsWith('.jsonl') && SESSION_ID.test(name.slice(0, -'.jsonl'.length))) files.add(path.join(root, dir, name));
    }
  }
  for (const file of transcriptFiles.keys()) if (!files.has(file)) transcriptFiles.delete(file);
  const list: TranscriptSession[] = [];
  for (const file of files) {
    const s = await readTranscript(file);
    if (s) list.push(fs.existsSync(s.cwd) ? s : { ...s, gone: true });
  }
  return list;
}

let pollingAgents = false;
async function pollAgents() {
  if (pollingAgents || !win || win.isDestroyed()) return;
  pollingAgents = true;
  try {
    // Each list goes out as soon as it is ready: the first read of the transcripts takes a moment.
    // The agents list says when it was asked for, so the renderer can tell it from a hook it predates.
    const asked = Date.now();
    await Promise.all([
      listAgents().then((list) => list && send('agents', list, asked)),
      listAppSessions().then((list) => send('app-sessions', list), () => {}),
      listTranscriptSessions().then((list) => send('transcript-sessions', list), () => {}),
    ]);
  } finally {
    pollingAgents = false;
  }
}

ipcMain.on('agents:stop', async (_e, sessionId: string, bgId?: string) => {
  const bg = (await listAgents())?.find(
    (a) => a.kind === 'background' && a.id && !a.ended && (a.sessionId === sessionId || a.id === bgId),
  );
  if (!bg?.id) return;
  if (process.env.LISZT_DEBUG) console.log('[agents] stop', bg.id, sessionId);
  // Stopping keeps the conversation; `claude attach <id>` or `--resume` brings it back.
  await runClaude(['stop', bg.id]).catch(() => {});
  void pollAgents();
});

// --- Closing and deleting sessions -------------------------------------------------------------
// The Sessions panel closes and deletes sessions wherever they run. A background session goes
// through Claude Code (`claude stop`, `claude rm`); an interactive one is closed by ending its
// process. Deleting either moves its conversation to the Trash, so a mistake can be undone.

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

async function runClaude(args: string[], timeout = 15_000, cwd?: string): Promise<string> {
  const { env, claude } = await shellEnv;
  return new Promise((resolve, reject) =>
    execFile(claude, args, { env, cwd, encoding: 'utf8', timeout }, (err, out, stderr) =>
      err ? reject(new Error(stderr.trim() || out.trim() || err.message)) : resolve(out),
    ),
  );
}

async function exited(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      // EPERM: the process exists but belongs to someone else.
      return (err as NodeJS.ErrnoException).code !== 'EPERM';
    }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Ends the processes running an interactive session and waits for them, so none writes its transcript afterwards. */
async function endInteractive(list: AgentSession[], sessionId: string) {
  const pids = list.filter((a) => a.kind === 'interactive' && a.sessionId === sessionId && a.pid).map((a) => a.pid!);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  for (const pid of pids) if (!(await exited(pid, 5000))) throw new Error(`Claude Code (pid ${pid}) did not exit.`);
}

/** Moves a conversation to the Trash: its transcript and the folder Claude Code keeps beside it for subagents. */
async function trashTranscript(sessionId: string) {
  const root = path.join(await claudeDir(), 'projects');
  for (const dir of await readDir(root)) {
    for (const name of [`${sessionId}.jsonl`, sessionId]) {
      const file = path.join(root, dir, name);
      if (fs.existsSync(file)) await shell.trashItem(file);
    }
  }
}

async function sessionAction(act: (list: AgentSession[]) => Promise<unknown>): Promise<GitResult> {
  const list = await listAgents();
  if (!list) return { ok: false, error: 'Claude Code did not list its sessions.' };
  try {
    await act(list);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  } finally {
    void pollAgents();
  }
}

ipcMain.handle('sessions:close', (_e, sessionId: string, bgId?: string) =>
  sessionAction(async (list) => {
    const bg = list.find((a) => a.kind === 'background' && a.id && !a.ended && (a.sessionId === sessionId || a.id === bgId));
    if (bg?.id) await runClaude(['stop', bg.id]);
    else await endInteractive(list, sessionId);
  }),
);

ipcMain.handle('sessions:delete', (_e, sessionId: string, bgId?: string) => {
  if (!SESSION_ID.test(sessionId)) return { ok: false, error: `Not a session id: ${sessionId}` };
  return sessionAction(async (list) => {
    const bg = list.find((a) => a.kind === 'background' && a.id && (a.sessionId === sessionId || a.id === bgId));
    // Claude Code's own delete; it keeps the worktree when that would lose work, and says so.
    if (bg?.id) await runClaude(['rm', bg.id], 60_000);
    else await endInteractive(list, sessionId);
    // `claude rm` may leave the transcript behind, and a deleted session should not be resumable.
    await trashTranscript(sessionId);
  });
});

/**
 * Moves a session to another folder (see New projects): stops it, files its transcript under the
 * new folder, where `claude --resume` looks for it, and removes the background session that ran it
 * in the old one, which would otherwise be listed and attached under the same session id.
 */
ipcMain.handle('sessions:move', async (_e, sessionId: string, bgId: string | undefined, to: string): Promise<MoveResult> => {
  if (!SESSION_ID.test(sessionId)) return { ok: false, error: `Not a session id: ${sessionId}` };
  const list = await listAgents();
  if (!list) return { ok: false, error: 'Claude Code did not list its sessions.' };
  try {
    const jobs = list.filter((a) => a.kind === 'background' && a.id && (a.sessionId === sessionId || a.id === bgId));
    for (const job of jobs) if (!job.ended) await runClaude(['stop', job.id!]);
    await endInteractive(list, sessionId);
    const root = path.join(await claudeDir(), 'projects');
    const dest = path.join(root, projectFolder(to));
    await fs.promises.mkdir(dest, { recursive: true });
    for (const dir of await readDir(root)) {
      if (dir === projectFolder(to)) continue;
      for (const name of [`${sessionId}.jsonl`, sessionId]) {
        const file = path.join(root, dir, name);
        if (fs.existsSync(file) && !fs.existsSync(path.join(dest, name))) await fs.promises.rename(file, path.join(dest, name));
      }
    }
    const transcript = path.join(dest, `${sessionId}.jsonl`);
    if (!fs.existsSync(transcript)) return { ok: false, error: 'The session has no transcript to move.' };
    // Its transcript is gone from the old folder, so this deletes nothing but the background session.
    for (const job of jobs) await runClaude(['rm', job.id!], 60_000).catch(() => {});
    return { ok: true, transcript };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  } finally {
    void pollAgents();
  }
});

// --- State, dialogs, notifications -------------------------------------------------------------

ipcMain.handle('state:load', (): AppState | null => {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.on('state:save', (_e, s: AppState) => {
  const tmp = `${statePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, statePath());
});

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0] ?? null;
});

ipcMain.on('open:external', (_e, url: string) => {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
});

function openPane(paneId: string) {
  win?.show();
  win?.focus();
  send('focus-pane', paneId);
}

ipcMain.on('notify', (_e, n: { title: string; body: string; paneId: string; kind: NotifyKind }) => notify(n, win, openPane));

ipcMain.on('badge', (_e, text: string) => app.dock?.setBadge(text));

// --- Git ---------------------------------------------------------------------------------------

async function runGit(cwd: string, args: string[], timeout = 5000): Promise<string> {
  const { env } = await shellEnv;
  // --no-optional-locks keeps the sidebar's polling from fighting Claude's own git commands over index.lock.
  return new Promise((resolve, reject) =>
    execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.quotepath=false', '-C', cwd, ...args],
      { env, encoding: 'utf8', timeout, maxBuffer: 16 << 20 },
      (err, out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(out)),
    ),
  );
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

ipcMain.handle('git:info', async (_e, cwd: string): Promise<GitInfo> => {
  const git = (args: string[]) => runGit(cwd, args);
  let status: string;
  try {
    status = await git(['status', '--porcelain=v1', '--branch']);
  } catch {
    return { isRepo: false };
  }
  const [head = '', ...lines] = status.split('\n');
  const info: GitInfo = { isRepo: true };
  const m = /^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
  if (m) {
    info.branch = m[1];
    info.upstream = m[2];
    info.ahead = Number(/ahead (\d+)/.exec(m[3] ?? '')?.[1] ?? 0);
    info.behind = Number(/behind (\d+)/.exec(m[3] ?? '')?.[1] ?? 0);
  }
  info.files = lines.filter(Boolean).map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
  const log = await git(['log', '-n', '20', '--format=%h%x09%cr%x09%s']).catch(() => '');
  info.commits = log
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash = '', when = '', ...subject] = l.split('\t');
      return { hash, when, subject: subject.join('\t') };
    });
  return info;
});

// --- Task worktrees ----------------------------------------------------------------------------
// Tasks get their own worktree under <repo>/.claude/worktrees/, the same place `claude --worktree`
// uses. Being inside the repo, they inherit its folder trust, so Claude starts without asking.

const WORKTREE_IGNORE = '/.claude/worktrees/';
const TURKISH: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' };

function slugify(title: string): string {
  const slug = title
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşü]/g, (ch) => TURKISH[ch])
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'task';
}

ipcMain.handle('worktree:add', async (_e, project: string, title: string): Promise<WorktreeResult> => {
  try {
    const top = fs.realpathSync((await runGit(project, ['rev-parse', '--show-toplevel'])).trim());
    const common = path.resolve(top, (await runGit(top, ['rev-parse', '--git-common-dir'])).trim());
    // Keep the worktrees out of the main checkout's status without touching its committed .gitignore.
    const exclude = path.join(common, 'info', 'exclude');
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!current.split('\n').includes(WORKTREE_IGNORE)) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${WORKTREE_IGNORE}\n`);
    }
    const slug = `${slugify(title)}-${randomBytes(2).toString('hex')}`;
    const dir = path.join(top, '.claude', 'worktrees', slug);
    const branch = `liszt/${slug}`;
    // LFS checkouts of big game repos can take minutes.
    await runGit(top, ['worktree', 'add', '-b', branch, dir, 'HEAD'], 10 * 60_000);
    // A project opened at a subfolder of its repo works in the same subfolder of the worktree.
    const cwd = path.join(dir, path.relative(top, fs.realpathSync(project)));
    return { ok: true, dir, cwd, branch };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
});

ipcMain.handle('worktree:remove', async (_e, project: string, dir: string): Promise<GitResult> => {
  try {
    // No --force: git refuses when the worktree has uncommitted or untracked files, so nothing is lost.
    await runGit(project, ['worktree', 'remove', dir], 60_000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
});

// --- Project icons -----------------------------------------------------------------------------
// A project tab shows the project's own icon when one can be found: the app icon a Unity project
// builds with, Godot's config/icon, an Xcode AppIcon, or a usual icon/logo/favicon file. Otherwise
// the renderer draws a glyph for the project kind.

const ICON_FILES = [
  'build/icon.png', 'icon.png', 'icon.svg', 'logo.png', 'logo.svg', 'assets/icon.png', 'assets/logo.png',
  'resources/icon.png', 'app/icon.svg', 'app/icon.png', 'app/apple-icon.png', 'src/app/icon.svg', 'src/app/icon.png',
  'src/app/apple-icon.png', 'src-tauri/icons/icon.png', 'public/apple-touch-icon.png', 'public/icon.png', 'public/logo.png', 'public/logo192.png',
  'public/favicon.svg', 'public/favicon.png', 'static/favicon.png', 'favicon.svg', 'favicon.png',
  'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
];

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) =>
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout: 8000, maxBuffer: 4 << 20 }, (_err, out) => resolve(out ?? '')),
  );
}

function projectKind(dir: string): ProjectKind {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 'folder';
  }
  if (has('ProjectSettings/ProjectVersion.txt')) return 'unity';
  if (has('project.godot')) return 'godot';
  if (has('Package.swift') || entries.some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'))) return 'apple';
  if (has('package.json')) return 'node';
  if (has('Cargo.toml')) return 'rust';
  if (has('go.mod')) return 'go';
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) return 'python';
  return 'folder';
}

/** The texture a Unity project uses as its app icon, resolved from PlayerSettings' GUIDs. */
async function unityIcon(dir: string): Promise<string | undefined> {
  let settings: string;
  try {
    settings = fs.readFileSync(path.join(dir, 'ProjectSettings', 'ProjectSettings.asset'), 'utf8');
  } catch {
    return undefined;
  }
  const guids: string[] = [];
  for (const key of ['m_BuildTargetIcons:', 'm_BuildTargetPlatformIcons:']) {
    const start = settings.indexOf(key);
    if (start < 0) continue;
    // The block ends at the next PlayerSettings key, which sits at two spaces of indentation.
    const end = settings.slice(start + key.length).search(/\n {2}m_\w+:/);
    const block = settings.slice(start, end < 0 ? undefined : start + key.length + end);
    for (const m of block.matchAll(/guid: ([0-9a-f]{32})/g)) if (!guids.includes(m[1])) guids.push(m[1]);
  }
  for (const guid of guids.slice(0, 3)) {
    const meta = (await run('grep', ['-rl', '--include=*.meta', '-m1', `guid: ${guid}`, 'Assets'], dir)).split('\n')[0];
    if (meta) return path.join(dir, meta.replace(/\.meta$/, ''));
  }
  return undefined;
}

async function appIconSet(dir: string): Promise<string | undefined> {
  const out = await run('find', ['.', '-maxdepth', '5', '-type', 'd', '-name', 'AppIcon.appiconset', '-not', '-path', '*/node_modules/*'], dir);
  const set = out.split('\n')[0];
  if (!set) return undefined;
  const pngs = fs.readdirSync(path.join(dir, set)).filter((f) => f.endsWith('.png'));
  const largest = pngs.map((f) => path.join(dir, set, f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  return largest;
}

function loadIcon(file: string): string | undefined {
  try {
    if (!fs.statSync(file).isFile()) return undefined;
  } catch {
    return undefined;
  }
  if (file.endsWith('.svg')) {
    const svg = fs.readFileSync(file);
    return svg.length < 256_000 ? `data:image/svg+xml;base64,${svg.toString('base64')}` : undefined;
  }
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return undefined;
  const { width, height } = img.getSize();
  return img.resize(width >= height ? { width: 64, quality: 'best' } : { height: 64, quality: 'best' }).toDataURL();
}

async function detectProjectIcon(dir: string): Promise<ProjectIcon> {
  const kind = projectKind(dir);
  const candidates: string[] = [];
  if (kind === 'unity') candidates.push((await unityIcon(dir)) ?? '');
  if (kind === 'godot') {
    const config = fs.readFileSync(path.join(dir, 'project.godot'), 'utf8');
    const m = /config\/icon="res:\/\/([^"]+)"/.exec(config);
    if (m) candidates.push(path.join(dir, m[1]));
  }
  if (kind === 'apple') candidates.push((await appIconSet(dir)) ?? '');
  candidates.push(...ICON_FILES.map((f) => path.join(dir, f)));
  for (const file of candidates.filter(Boolean)) {
    const image = loadIcon(file);
    if (image) return { kind, image };
  }
  return { kind };
}

ipcMain.handle('project:icon', (_e, dir: string) => detectProjectIcon(dir).catch((): ProjectIcon => ({ kind: 'folder' })));

ipcMain.handle('dialog:pickIcon', async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'icns'] }],
  });
  return r.canceled || !r.filePaths[0] ? null : loadIcon(r.filePaths[0]) ?? null;
});

ipcMain.on('shell:reveal', (_e, dir: string) => shell.showItemInFolder(dir));
ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text));

// --- Window and menu ---------------------------------------------------------------------------

function buildMenu() {
  const cmd = (command: string) => () => send('menu', command);
  const projectKeys: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Project ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: cmd(`project-${i}`),
    visible: false,
    acceleratorWorksWhenHidden: true,
  }));
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Claude Pane', accelerator: 'CmdOrCtrl+T', click: cmd('new-claude') },
        { label: 'New Shell Pane', accelerator: 'CmdOrCtrl+Shift+T', click: cmd('new-shell') },
        { label: 'Split Right with New Session', accelerator: 'CmdOrCtrl+D', click: cmd('split-right') },
        { label: 'Split Down with New Session', accelerator: 'CmdOrCtrl+Shift+D', click: cmd('split-down') },
        { label: 'Close Session', accelerator: 'CmdOrCtrl+W', click: cmd('close-pane') },
        { type: 'separator' },
        { label: 'New Project…', accelerator: 'Ctrl+N', registerAccelerator: false, click: cmd('new-project') },
        { label: 'Add Project…', accelerator: 'CmdOrCtrl+O', click: cmd('add-project') },
        { label: 'Close Project', accelerator: 'CmdOrCtrl+Shift+W', click: cmd('close-project') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Changes', accelerator: 'CmdOrCtrl+B', click: cmd('toggle-sidebar') },
        { label: 'Toggle Sessions', accelerator: 'CmdOrCtrl+L', click: cmd('toggle-sessions') },
        { label: 'Toggle Tasks', accelerator: 'CmdOrCtrl+J', click: cmd('toggle-tasks') },
        { type: 'separator' },
        { label: 'Next Session', accelerator: 'CmdOrCtrl+]', click: cmd('next-pane') },
        { label: 'Previous Session', accelerator: 'CmdOrCtrl+[', click: cmd('prev-pane') },
        { label: 'Next Project', accelerator: 'CmdOrCtrl+Shift+]', click: cmd('next-project') },
        { label: 'Previous Project', accelerator: 'CmdOrCtrl+Shift+[', click: cmd('prev-project') },
        ...projectKeys,
        { type: 'separator' },
        { label: 'Bigger Text', accelerator: 'CmdOrCtrl+=', click: cmd('font-up') },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: cmd('font-down') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: cmd('font-reset') },
        { type: 'separator' },
        { label: 'Switch Chat / Terminal', accelerator: 'CmdOrCtrl+E', click: cmd('toggle-view') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { label: 'Notifications', submenu: notificationsMenu() },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Which channels announce a session that wants input or has finished, and a way to try them. */
function notificationsMenu(): MenuItemConstructorOptions[] {
  const prefs = notifyPrefs();
  const toggle = (key: keyof NotifyPrefs, label: string): MenuItemConstructorOptions => ({
    label,
    type: 'checkbox',
    checked: prefs[key],
    click: (item) => setNotifyPref(key, item.checked),
  });
  const test = (kind: NotifyKind) => () =>
    notify(
      kind === 'attention'
        ? { kind, paneId: '', title: 'Liszt · Test', body: 'Claude needs your permission to use Bash' }
        : { kind, paneId: '', title: 'Liszt · Test', body: 'Finished in 2m 14s · 12 tool calls' },
      null,
      openPane,
    );
  return [
    toggle('banner', 'Liszt Banner'),
    toggle('sound', 'Sound'),
    toggle('dock', 'Bounce Dock Icon'),
    toggle('system', 'macOS Notification Center'),
    { type: 'separator' },
    { label: 'Test “Needs Input”', click: test('attention') },
    { label: 'Test “Finished”', click: test('done') },
  ];
}

function createWindow() {
  const capture = process.env.LISZT_CAPTURE;
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#0b0b0c',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => (capture ? win?.showInactive() : win?.show()));
  win.webContents.on('did-finish-load', () => void pollAgents());
  void win.loadFile(path.join(__dirname, 'index.html'));

  // Test hook: LISZT_TEST_SCRIPT=<file.js> runs a script in the page once it has loaded.
  const testScript = process.env.LISZT_TEST_SCRIPT;
  if (testScript) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(
        () =>
          void win?.webContents
            .executeJavaScript(fs.readFileSync(testScript, 'utf8'))
            .then((result) => console.log('[test]', JSON.stringify(result)))
            .catch(console.error),
        2500,
      ),
    );
  }

  // Test hook: LISZT_CAPTURE=<file.png> saves a screenshot after a delay and quits.
  if (capture) {
    setTimeout(async () => {
      const img = await win!.webContents.capturePage();
      fs.writeFileSync(capture, img.toPNG());
      app.quit();
    }, Number(process.env.LISZT_CAPTURE_DELAY ?? 8000));
  }
}

app.on('second-instance', () => {
  win?.show();
  win?.focus();
});

app.whenReady().then(() => {
  fs.mkdirSync(userData(), { recursive: true });
  writeClaudeSettings();
  writeMoveScript();
  loadNotifyPrefs();
  hookUrl = startHookServer();
  // A socket path must stay short (macOS allows 104 bytes), so it sits right in userData.
  configureHost(path.join(userData(), `host-${HOST_PROTOCOL}.sock`), path.join(__dirname, 'host.js'));
  buildMenu();
  createWindow();
  setInterval(() => void pollAgents(), AGENTS_INTERVAL);
});

// Quitting ends the panes' terminals and lets go of the chats. A chat's session runs in the session
// host and a terminal Claude pane only attaches to its background session, so both keep working
// and are attached again on the next start; shells and panes that run claude themselves end here. Hooks fired meanwhile find no address and send nothing.
app.on('before-quit', () => {
  // The chats go on in the session host.
  detachAllChats();
  for (const p of ptys.values()) p.kill();
  ptys.clear();
  fs.rmSync(hookUrlFile(), { force: true });
});

app.on('window-all-closed', () => app.quit());
