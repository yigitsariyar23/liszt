import { BrowserWindow, Menu, Notification, app, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AgentSession,
  AppSession,
  AppState,
  GitInfo,
  GitResult,
  HookEvent,
  ProjectIcon,
  ProjectKind,
  ProjectMenuOptions,
  SessionMenuOptions,
  SessionRowMenuOptions,
  SpawnOptions,
  SpawnResult,
  WorktreeResult,
} from '../shared/types';

if (process.env.LISZT_USER_DATA) app.setPath('userData', process.env.LISZT_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

const userData = () => app.getPath('userData');
const statePath = () => path.join(userData(), 'state.json');

let win: BrowserWindow | null = null;
let settingsFile = '';
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
// Each claude pane is started with `--settings <file>` holding these hooks. Every hook posts its
// JSON payload to a loopback server, tagged with the pane id from the pane's environment; a random
// token keeps other local processes from faking events. The output is discarded so nothing leaks
// into Claude's context, and a failure never blocks Claude.

function writeClaudeSettings(): string {
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
  const file = path.join(userData(), 'claude-settings.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

function startHookServer(): Promise<string> {
  const token = randomBytes(16).toString('hex');
  const server = http.createServer((req, res) => {
    const params = new URL(req.url ?? '/', 'http://liszt').searchParams;
    const paneId = params.get('pane');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
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
      };
      if (process.env.LISZT_DEBUG) console.log('[hook]', paneId, ev.event, ev.source ?? '');
      send('hook', ev);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      const url = `http://127.0.0.1:${port}/hook?token=${token}`;
      if (process.env.LISZT_DEBUG) fs.writeFileSync(path.join(userData(), 'hook-url.txt'), url);
      resolve(url);
    });
  });
}

let hookUrl: Promise<string> = new Promise(() => {});

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

// --- Terminals ---------------------------------------------------------------------------------

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const BACKGROUNDED = /backgrounded\W+([0-9a-f]{8})\b/;

ipcMain.handle('pty:spawn', async (_e, o: SpawnOptions): Promise<SpawnResult> => {
  const { env, claude } = await shellEnv;
  const hook = await hookUrl;
  const old = ptys.get(o.paneId);
  ptys.delete(o.paneId);
  old?.kill();

  const paneEnv: Record<string, string> = {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Liszt',
    LISZT_PANE_ID: o.paneId,
    LISZT_HOOK_URL: hook,
  };
  paneEnv.LANG ||= 'en_US.UTF-8';

  // A background session is attached while Claude Code still knows it, even done or stopped:
  // attach wakes it on the conversation it last had, whereas the listed session id is the one it
  // started with, from before any /clear. Once it is removed it is resumed by session id.
  const attach =
    o.kind === 'claude' && o.attach && (await listAgents())?.some((a) => a.kind === 'background' && a.id === o.attach)
      ? o.attach
      : undefined;
  // Claude cleans up old transcripts; resuming one that is gone lands in its session picker, so
  // start a new session instead.
  let { resume, sessionId } = o;
  if (!attach && resume && o.transcript && !fs.existsSync(o.transcript)) {
    resume = false;
    sessionId = randomUUID();
  }

  const [file, args] =
    o.kind === 'claude'
      ? [claude, attach ? ['attach', attach] : ['--settings', settingsFile, resume ? '--resume' : '--session-id', sessionId]]
      : [env.SHELL || '/bin/zsh', ['-l']];
  // `--` keeps a prompt that starts with a dash from being read as an option.
  if (o.kind === 'claude' && o.prompt && !resume && !attach) args.push('--', o.prompt);
  const cwd = fs.existsSync(o.cwd) ? o.cwd : os.homedir();

  let p: pty.IPty;
  try {
    p = pty.spawn(file, args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd, env: paneEnv });
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  ptys.set(o.paneId, p);
  // `/background` hands the conversation to Claude Code's background server under a new session id
  // and prints the short id before exiting; that line is the only link back to this pane.
  let tail = '';
  // A restarted pane reuses its id, so ignore anything the replaced process still emits.
  p.onData((data) => {
    if (ptys.get(o.paneId) !== p) return;
    send('pty:data', o.paneId, data);
    if (o.kind !== 'claude' || attach) return;
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
  return { ok: true, sessionId, resumed: resume, attached: Boolean(attach) };
});

ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.get(id)?.write(data));

ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
  try {
    ptys.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 1));
  } catch {
    // The process may have exited between the renderer's measure and this call.
  }
});

ipcMain.on('pty:kill', (_e, id: string) => {
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
      status: fields.status === 'busy' ? 'busy' : 'idle',
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

let pollingAgents = false;
async function pollAgents() {
  if (pollingAgents || !win || win.isDestroyed()) return;
  pollingAgents = true;
  try {
    const [list, appList] = await Promise.all([listAgents(), listAppSessions().catch(() => null)]);
    if (list) send('agents', list);
    if (appList) send('app-sessions', appList);
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

async function runClaude(args: string[], timeout = 15_000): Promise<string> {
  const { env, claude } = await shellEnv;
  return new Promise((resolve, reject) =>
    execFile(claude, args, { env, encoding: 'utf8', timeout }, (err, out, stderr) =>
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

ipcMain.on('notify', (_e, n: { title: string; body: string; paneId: string }) => {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body });
  note.on('click', () => {
    win?.show();
    win?.focus();
    send('focus-pane', n.paneId);
  });
  note.show();
});

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

ipcMain.handle('menu:project', (_e, o: ProjectMenuOptions) => {
  return new Promise<string | null>((resolve) => {
    const item = (label: string, id: string, enabled = true): MenuItemConstructorOptions => ({ label, enabled, click: () => resolve(id) });
    const template: MenuItemConstructorOptions[] = [item('Rename…', 'rename')];
    if (o.renamed) template.push(item('Use Folder Name', 'reset-name'));
    template.push(
      { type: 'separator' },
      item(o.folded ? 'Unfold' : 'Fold', 'fold'),
      item('Fold Others', 'fold-others', o.othersUnfolded),
      item('Unfold All', 'unfold-all', o.anyFolded),
      { type: 'separator' },
      item('Choose Icon…', 'icon-choose'),
      item('Detect Icon Again', 'icon-detect'),
      { type: 'separator' },
      item('Reveal in Finder', 'reveal'),
      { type: 'separator' },
      item('Close Project', 'close'),
    );
    Menu.buildFromTemplate(template).popup({ window: win!, callback: () => setTimeout(() => resolve(null), 100) });
  });
});

ipcMain.handle('menu:session', (_e, o: SessionMenuOptions) => {
  return new Promise<string | null>((resolve) => {
    const item = (label: string, id: string, enabled = true): MenuItemConstructorOptions => ({ label, enabled, click: () => resolve(id) });
    const template: MenuItemConstructorOptions[] = [item('Rename…', 'rename')];
    if (o.renamed) template.push(item('Use Automatic Name', 'reset-name'));
    template.push(
      item(o.unread ? 'Mark as Read' : 'Mark as Unread', 'unread'),
      { type: 'separator' },
      item('Split Right', 'split-right', o.canSplit),
      item('Split Down', 'split-down', o.canSplit),
      item('Take Out of Split', 'unsplit', o.inSplit),
      { type: 'separator' },
      item('Reveal in Finder', 'reveal'),
    );
    if (o.claude) template.push(item('Copy Session ID', 'copy-id', o.started));
    template.push({ type: 'separator' }, item('Close Session', 'close'), item('Close Other Sessions', 'close-others', o.others));
    Menu.buildFromTemplate(template).popup({ window: win!, callback: () => setTimeout(() => resolve(null), 100) });
  });
});

ipcMain.handle('menu:session-row', (_e, o: SessionRowMenuOptions) => {
  return new Promise<string | null>((resolve) => {
    const item = (label: string, id: string, enabled = true): MenuItemConstructorOptions => ({ label, enabled, click: () => resolve(id) });
    const template: MenuItemConstructorOptions[] = [
      item(o.inLiszt ? 'Show Session' : 'Open in Liszt', 'open', o.canOpen),
      { type: 'separator' },
      item('Close Session', 'close', o.canClose),
      o.archived ? item('Unarchive', 'unarchive') : item(o.canClose ? 'Close and Archive' : 'Archive', 'archive'),
      { type: 'separator' },
      item('Delete Session…', 'delete'),
    ];
    Menu.buildFromTemplate(template).popup({ window: win!, callback: () => setTimeout(() => resolve(null), 100) });
  });
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
        { role: 'toggleDevTools' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
  settingsFile = writeClaudeSettings();
  hookUrl = startHookServer();
  buildMenu();
  createWindow();
  setInterval(() => void pollAgents(), AGENTS_INTERVAL);
});

// Quitting leaves background sessions running: the panes resume them on the next start.
app.on('before-quit', () => {
  for (const p of ptys.values()) p.kill();
  ptys.clear();
});

app.on('window-all-closed', () => app.quit());
