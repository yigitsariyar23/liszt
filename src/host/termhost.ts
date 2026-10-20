// Liszt's terminal host: a small process of its own that runs the shells behind shell panes, so
// they and whatever they run (`npm run dev`, a watcher, a server) keep going after Liszt quits.
// Liszt starts it on demand and talks to it over a unix socket. A connection's first line is a JSON
// request: `list`, `kill`, `stop` and `ping` are answered with one JSON line; `spawn` and `attach`
// turn the connection into the terminal's, framed as JSON lines both ways: `{d}` is output or
// input, `{r: [cols, rows]}` a resize and `{exit}` the end of the shell. Each shell is mirrored in
// a headless terminal, so a Liszt that attaches again gets the screen and scrollback as they are.
// The host leaves once it has had no shell and no connection for a while.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';

import { TERM_PROTOCOL, type HostTerm, type TermJob } from '../shared/types';

interface Shell {
  id: string;
  p: pty.IPty;
  mirror: Terminal;
  serialize: SerializeAddon;
  conn: net.Socket | null;
}

/** As much scrollback as a pane keeps. */
const SCROLLBACK = 10_000;

const sock = process.argv[2];
const logFile = path.join(path.dirname(sock), 'termhost.log');
const shells = new Map<string, Shell>();
let conns = 0;
let idleSince = Date.now();

function log(...parts: unknown[]) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${parts.map(String).join(' ')}\n`);
  } catch {
    // Logging is best effort.
  }
}

const frame = (x: unknown) => `${JSON.stringify(x)}\n`;

/** Reads a connection's JSON lines after its first. */
function lines(conn: net.Socket, first: string, each: (m: Record<string, unknown>) => void) {
  let rest = first;
  const take = () => {
    let nl: number;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      try {
        each(JSON.parse(line));
      } catch {
        // A broken line is dropped.
      }
    }
  };
  conn.on('data', (d: Buffer) => {
    rest += d.toString('utf8');
    take();
  });
  take();
}

function resize(s: Shell, size: unknown) {
  if (!Array.isArray(size)) return;
  const cols = Math.max(2, Number(size[0]) | 0);
  const rows = Math.max(1, Number(size[1]) | 0);
  try {
    s.p.resize(cols, rows);
    s.mirror.resize(cols, rows);
  } catch {
    // The shell may have exited meanwhile.
  }
}

function startShell(id: string, o: { file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }): Shell {
  const p = pty.spawn(o.file, o.args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env });
  const mirror = new Terminal({ cols: o.cols, rows: o.rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const serialize = new SerializeAddon();
  mirror.loadAddon(serialize);
  const s: Shell = { id, p, mirror, serialize, conn: null };
  shells.set(id, s);
  log('spawned', id, p.pid);
  p.onData((d) => {
    mirror.write(d);
    s.conn?.write(frame({ d }));
  });
  p.onExit(({ exitCode }) => {
    log('exit', id, exitCode);
    if (shells.get(id) === s) shells.delete(id);
    s.conn?.end(frame({ exit: exitCode }));
    mirror.dispose();
    if (!shells.size) idleSince = Date.now();
  });
  return s;
}

/** Hands the shell to a connection; `screen` first sends what the shell shows so far. */
function connect(s: Shell, conn: net.Socket, rest: string, screen: boolean) {
  // One Liszt drives a shell at a time; a newer connection takes over.
  if (s.conn && s.conn !== conn) s.conn.destroy();
  if (screen) {
    // Holds the shell's output until the mirror has taken in everything so far.
    s.conn = null;
    s.mirror.write('', () => {
      if (!shells.has(s.id) || conn.destroyed) return;
      conn.write(frame({ d: s.serialize.serialize({ scrollback: SCROLLBACK }) }));
      s.conn = conn;
    });
  } else s.conn = conn;
  log('attached', s.id);
  lines(conn, rest, (m) => {
    if (typeof m.d === 'string') s.p.write(m.d);
    if (m.r) resize(s, m.r);
  });
  conn.on('close', () => {
    if (s.conn !== conn) return;
    s.conn = null;
    log('detached', s.id);
  });
}

// --- Jobs --------------------------------------------------------------------------------------
// A job is a process group whose first process the shell started itself, as job control does for
// each command line. `ps` says which group holds the terminal.

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  seconds: number;
  command: string;
}

/** `ps` elapsed time, [[dd-]hh:]mm:ss, in seconds. */
function seconds(etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
  return Number(days) * 86400 + clock.split(':').reduce((t, part) => t * 60 + Number(part), 0);
}

function processes(): Promise<Proc[]> {
  return new Promise((resolve) => {
    const child = execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,etime=,command='], { encoding: 'utf8', maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return resolve([]);
      const list: Proc[] = [];
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (m) list.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], tpgid: +m[4], seconds: seconds(m[5]), command: m[6] });
      }
      resolve(list);
    });
    child.stdin?.end();
  });
}

function jobsOf(shellPid: number, procs: Proc[]): TermJob[] {
  const shell = procs.find((x) => x.pid === shellPid);
  if (!shell) return [];
  const now = Date.now();
  return procs
    .filter((x) => x.ppid === shellPid && x.pid === x.pgid && x.pgid !== shell.pgid)
    .map((x) => ({ pgid: x.pgid, command: x.command, foreground: x.pgid === shell.tpgid, since: now - x.seconds * 1000 }));
}

async function list(): Promise<HostTerm[]> {
  const procs = shells.size ? await processes() : [];
  return [...shells.values()].map((s) => ({ id: s.id, pid: s.p.pid, jobs: jobsOf(s.p.pid, procs) }));
}

const alive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stops one of a shell's jobs as Ctrl+C would, and harder if that does not end it. */
async function stopJob(s: Shell, pgid: number): Promise<boolean> {
  if (!jobsOf(s.p.pid, await processes()).some((j) => j.pgid === pgid)) return false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-pgid, signal);
    } catch {
      return true;
    }
    for (let i = 0; i < 20 && alive(pgid); i++) await new Promise((r) => setTimeout(r, 100));
    if (!alive(pgid)) return true;
  }
  return !alive(pgid);
}

// --- Socket ------------------------------------------------------------------------------------

type SpawnRequest = { file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number };

const server = net.createServer({ allowHalfOpen: true }, (conn) => {
  conns++;
  conn.on('close', () => {
    conns--;
    idleSince = Date.now();
  });
  conn.on('error', () => {});
  // Liszt going away only half-closes the connection; the rest of it goes too.
  conn.on('end', () => conn.end());
  let head = '';
  const onHead = (d: Buffer) => {
    head += d.toString('utf8');
    const nl = head.indexOf('\n');
    if (nl < 0) return;
    conn.off('data', onHead);
    const rest = head.slice(nl + 1);
    let req: Record<string, unknown>;
    try {
      req = JSON.parse(head.slice(0, nl));
    } catch {
      conn.end();
      return;
    }
    const id = typeof req.id === 'string' ? req.id : '';
    const reply = (x: unknown) => conn.end(frame(x));
    const s = shells.get(id);
    switch (req.op) {
      case 'ping':
        return reply({ protocol: TERM_PROTOCOL, pid: process.pid });
      case 'list':
        return void list().then(reply);
      case 'kill':
        s?.p.kill();
        return reply({ ok: Boolean(s) });
      case 'stop':
        return void (s ? stopJob(s, Number(req.pgid)) : Promise.resolve(false)).then((ok) => reply({ ok }));
      case 'spawn': {
        if (s) {
          shells.delete(id);
          s.p.kill();
        }
        let started: Shell;
        try {
          started = startShell(id, req as unknown as SpawnRequest);
        } catch (err) {
          log('spawn failed', id, err instanceof Error ? err.message : String(err));
          return reply({ exit: -1, error: String(err) });
        }
        return connect(started, conn, rest, false);
      }
      case 'attach':
        if (!s) return reply({ exit: null });
        resize(s, req.size);
        return connect(s, conn, rest, true);
    }
    conn.end();
  };
  conn.on('data', onHead);
});

/** Leaves once nothing has used it for a while; Liszt starts another when it needs one. */
const IDLE_EXIT = 60_000;
setInterval(() => {
  if (!shells.size && !conns && Date.now() - idleSince > IDLE_EXIT) {
    log('idle, leaving');
    server.close();
    try {
      fs.unlinkSync(sock);
    } catch {
      // Gone already.
    }
    process.exit(0);
  }
}, 10_000);

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    // Ended on purpose: its shells end with it.
    for (const s of shells.values()) s.p.kill();
    process.exit(0);
  });
}

try {
  fs.unlinkSync(sock);
} catch {
  // No stale socket.
}
server.listen(sock, () => {
  fs.chmodSync(sock, 0o600);
  log('host up', process.pid, `protocol ${TERM_PROTOCOL}`);
});
server.on('error', (err) => {
  log('listen failed', err.message);
  process.exit(1);
});
