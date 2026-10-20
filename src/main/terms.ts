// --- Shells ------------------------------------------------------------------------------------
// A shell pane's shell runs in Liszt's terminal host (see termhost.ts), so it and the jobs it runs
// keep going after Liszt quits. A pane whose shell is still running there is attached to again and
// shown the screen as the host kept it; otherwise a new shell starts.

import * as net from 'node:net';
import type { HostTerm } from '../shared/types';
import { hostClient, type HostClient } from './hostclient';

let host: HostClient | null = null;

/** Where the host listens and the script it runs; set once by main. */
export function configureTerms(sock: string, script: string) {
  host = hostClient(sock, script);
}

/** A shell in the host, as the pane's terminal drives it. */
export interface Shell {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Ends the shell. */
  kill(): void;
  /** Lets go of it and leaves it running. */
  detach(): void;
  onData(cb: (data: string) => void): void;
  /** The shell ended; null when the host went away with it. */
  onExit(cb: (code: number | null) => void): void;
}

export interface ShellStart {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** The pane's shell: the one still running in the host, or a new one. Null when there is no host. */
export async function openShell(paneId: string, o: ShellStart): Promise<Shell | null> {
  if (!host || !(await host.ensure())) return null;
  const live = (await host.ask<HostTerm[]>({ op: 'list' }))?.some((t) => t.id === paneId);
  const conn = net.createConnection(host.sock);
  const req = live
    ? { op: 'attach', id: paneId, size: [o.cols, o.rows] }
    : { op: 'spawn', id: paneId, file: o.file, args: o.args, cwd: o.cwd, env: o.env, cols: o.cols, rows: o.rows };
  let dataCb: (data: string) => void = () => {};
  let exitCb: (code: number | null) => void = () => {};
  let ended = false;
  const end = (code: number | null) => {
    if (ended) return;
    ended = true;
    exitCb(code);
  };
  let rest = '';
  conn.on('data', (d: Buffer) => {
    rest += d.toString('utf8');
    let nl: number;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      let m: { d?: unknown; exit?: unknown };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof m.d === 'string') dataCb(m.d);
      if ('exit' in m) end(typeof m.exit === 'number' ? m.exit : null);
    }
  });
  conn.on('error', () => {});
  conn.on('close', () => end(null));
  conn.write(`${JSON.stringify(req)}\n`);
  const send = (x: unknown) => {
    if (!conn.destroyed) conn.write(`${JSON.stringify(x)}\n`);
  };
  return {
    write: (data) => send({ d: data }),
    resize: (cols, rows) => send({ r: [cols, rows] }),
    kill: () => {
      ended = true;
      conn.destroy();
      void host?.ask({ op: 'kill', id: paneId });
    },
    detach: () => {
      ended = true;
      conn.destroy();
    },
    onData: (cb) => (dataCb = cb),
    onExit: (cb) => (exitCb = cb),
  };
}

/** The shells the host runs and their jobs; empty when there is no host. */
export async function listShells(): Promise<HostTerm[]> {
  return (await host?.ask<HostTerm[]>({ op: 'list' })) ?? [];
}

/** Stops one of a shell's jobs, as Ctrl+C would and harder if it holds on. */
export async function stopJob(paneId: string, pgid: number): Promise<boolean> {
  return Boolean((await host?.ask<{ ok: boolean }>({ op: 'stop', id: paneId, pgid }, 10_000))?.ok);
}
