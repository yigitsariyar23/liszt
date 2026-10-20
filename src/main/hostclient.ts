// What Liszt needs to use one of its hosts (see src/host/): a process of its own that outlives
// Liszt, started on demand and reached over a unix socket, whose connections open with one JSON line.

import { spawn } from 'node:child_process';
import * as net from 'node:net';

export interface HostClient {
  /** Where it listens. */
  sock: string;
  /** Sends one request and reads the one-line answer; null when no host answers. */
  ask<T>(req: Record<string, unknown>, timeout?: number): Promise<T | null>;
  /** Starts the host unless one is running; false when none would come up. */
  ensure(): Promise<boolean>;
}

export function hostClient(sock: string, script: string): HostClient {
  const ask = <T>(req: Record<string, unknown>, timeout = 3000): Promise<T | null> =>
    new Promise((resolve) => {
      const conn = net.createConnection(sock);
      let out = '';
      const done = (v: T | null) => {
        conn.destroy();
        resolve(v);
      };
      conn.setTimeout(timeout, () => done(null));
      conn.on('error', () => done(null));
      conn.on('data', (d) => (out += d.toString('utf8')));
      conn.on('end', () => {
        try {
          done(JSON.parse(out));
        } catch {
          done(null);
        }
      });
      conn.write(`${JSON.stringify(req)}\n`);
    });

  let starting: Promise<boolean> | null = null;
  // It outlives Liszt, so it is its own process group.
  const ensure = () =>
    (starting ??= (async () => {
      if (await ask({ op: 'ping' })) return true;
      const child = spawn(process.execPath, [script, sock], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      child.unref();
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (await ask({ op: 'ping' }, 500)) return true;
      }
      return false;
    })().finally(() => (starting = null)));

  return { sock, ask, ensure };
}
