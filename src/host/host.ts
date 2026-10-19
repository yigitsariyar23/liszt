// Liszt's session host: a small process of its own that runs the claude processes behind chat
// panes, so they keep working after Liszt quits. Liszt starts it on demand and talks to it over a
// unix socket. A connection's first line is a JSON request: `list`, `kill` and `ping` are answered
// with one JSON line; `spawn` and `attach` turn the connection into the session's stdio, which the
// Agent SDK in Liszt drives. When the connection goes, the session goes on; its output is read and
// dropped meanwhile, so it never blocks, and Liszt reads what it missed from the transcript. The
// host follows each session far enough to say whether it is busy or waiting on a permission, and
// leaves once it has had no session and no connection for a while.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { HOST_PROTOCOL, type HostSession } from '../shared/types';

interface Session {
  id: string;
  child: ChildProcess;
  conn: net.Socket | null;
  sessionId?: string;
  busy: boolean;
  /** Permission requests awaiting a response, by request id. */
  asks: Set<string>;
}

const sock = process.argv[2];
const dir = path.dirname(sock);
const childrenFile = path.join(dir, 'host-children.json');
const logFile = path.join(dir, 'host.log');
const sessions = new Map<string, Session>();
let conns = 0;
let idleSince = Date.now();

function log(...parts: unknown[]) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${parts.map(String).join(' ')}\n`);
  } catch {
    // Logging is best effort.
  }
}

/** The claude processes a host that died left behind: nothing can reach them, so they are ended. */
function reapOrphans() {
  let pids: number[] = [];
  try {
    pids = JSON.parse(fs.readFileSync(childrenFile, 'utf8'));
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      // The pid may belong to something else by now.
      if (!execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes('stream-json')) continue;
      process.kill(pid, 'SIGTERM');
      log('reaped', pid);
    } catch {
      // Already gone.
    }
  }
}

function saveChildren() {
  try {
    fs.writeFileSync(childrenFile, JSON.stringify([...sessions.values()].map((s) => s.child.pid).filter(Boolean)));
  } catch {
    // The next write tries again.
  }
}

/** Follows the session's stream-json lines, in either direction, for its busy and asking state. */
function follow(s: Session, from: 'claude' | 'liszt') {
  let rest = '';
  return (chunk: Buffer) => {
    rest += chunk.toString('utf8');
    let nl: number;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof m.session_id === 'string') s.sessionId = m.session_id;
      const request = m.request as Record<string, unknown> | undefined;
      const response = m.response as Record<string, unknown> | undefined;
      if (from === 'liszt') {
        if (m.type === 'user') s.busy = true;
        if (m.type === 'control_response' && typeof response?.request_id === 'string') s.asks.delete(response.request_id);
      } else {
        if (m.type === 'stream_event' || m.type === 'assistant') s.busy = true;
        if (m.type === 'result') {
          s.busy = false;
          s.asks.clear();
        }
        if (m.type === 'control_request' && request?.subtype === 'can_use_tool' && typeof m.request_id === 'string') s.asks.add(m.request_id);
        if (m.type === 'control_cancel_request' && typeof m.request_id === 'string') s.asks.delete(m.request_id);
      }
    }
  };
}

function describe(s: Session): HostSession {
  return { id: s.id, pid: s.child.pid ?? 0, sessionId: s.sessionId, busy: s.busy, asking: s.asks.size > 0, attached: Boolean(s.conn) };
}

function startSession(id: string, o: { command: string; args: string[]; cwd?: string; env: Record<string, string> }): Session {
  const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const s: Session = { id, child, conn: null, busy: false, asks: new Set() };
  sessions.set(id, s);
  saveChildren();
  log('spawned', id, child.pid);
  const watch = follow(s, 'claude');
  child.stdout!.on('data', (d: Buffer) => {
    watch(d);
    s.conn?.write(d);
  });
  child.stderr!.on('data', (d: Buffer) => log('stderr', id, d.toString('utf8').trim().slice(0, 500)));
  child.stdin!.on('error', () => {});
  child.on('error', (err) => log('error', id, err.message));
  child.on('exit', (code, signal) => {
    log('exit', id, code, signal);
    if (sessions.get(id) === s) sessions.delete(id);
    saveChildren();
    s.conn?.end();
    if (!sessions.size) idleSince = Date.now();
  });
  return s;
}

function connect(s: Session, conn: net.Socket, first: string) {
  // One Liszt drives a session at a time; a newer connection takes over.
  if (s.conn && s.conn !== conn) s.conn.destroy();
  s.conn = conn;
  log('attached', s.id);
  const watch = follow(s, 'liszt');
  const write = (d: Buffer) => {
    watch(d);
    if (s.child.stdin?.writable) s.child.stdin.write(d);
  };
  if (first) write(Buffer.from(first, 'utf8'));
  conn.on('data', write);
  conn.on('close', () => {
    if (s.conn !== conn) return;
    s.conn = null;
    log('detached', s.id);
  });
}

function stop(s: Session) {
  s.child.kill('SIGTERM');
  setTimeout(() => {
    if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill('SIGKILL');
  }, 3000).unref();
}

const server = net.createServer({ allowHalfOpen: true }, (conn) => {
  conns++;
  conn.on('close', () => {
    conns--;
    idleSince = Date.now();
  });
  conn.on('error', () => {});
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
    const reply = (x: unknown) => conn.end(`${JSON.stringify(x)}\n`);
    switch (req.op) {
      case 'ping':
        return reply({ protocol: HOST_PROTOCOL, pid: process.pid });
      case 'list':
        return reply([...sessions.values()].map(describe));
      case 'kill': {
        const s = sessions.get(id);
        if (s) stop(s);
        return reply({ ok: Boolean(s) });
      }
      case 'spawn': {
        const old = sessions.get(id);
        if (old) {
          sessions.delete(id);
          stop(old);
        }
        const s = startSession(id, req as unknown as { command: string; args: string[]; cwd?: string; env: Record<string, string> });
        return connect(s, conn, rest);
      }
      case 'attach': {
        const s = sessions.get(id);
        if (!s) return void conn.end();
        return connect(s, conn, rest);
      }
    }
    conn.end();
  };
  conn.on('data', onHead);
});

/** Leaves once nothing has used it for a while; Liszt starts another when it needs one. */
const IDLE_EXIT = 60_000;
setInterval(() => {
  if (!sessions.size && !conns && Date.now() - idleSince > IDLE_EXIT) {
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
    // Ended on purpose: its sessions end with it rather than run on unreachable.
    for (const s of sessions.values()) s.child.kill('SIGTERM');
    process.exit(0);
  });
}

reapOrphans();
try {
  fs.unlinkSync(sock);
} catch {
  // No stale socket.
}
server.listen(sock, () => {
  fs.chmodSync(sock, 0o600);
  log('host up', process.pid, `protocol ${HOST_PROTOCOL}`);
});
server.on('error', (err) => {
  log('listen failed', err.message);
  process.exit(1);
});
