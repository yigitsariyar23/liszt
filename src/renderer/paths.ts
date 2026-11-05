import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import type { LisztApi } from '../main/preload';
import { logicalLine } from './viewer';

// Local paths a terminal prints, made clickable: a click shows the place in Finder, a Shift-click
// opens it in VS Code. Only a path that exists on disk becomes a link, so a slash command or a
// fraction stays plain text, and a path may hold spaces (`~/Creative Studio v2/exports/`).

/**
 * Where a path may start: absolute, from home, `./` or `../`, a file: address, or a relative one
 * like `src/a.ts`. Not inside a longer path, a web address or a word.
 */
const START = /(?<![\w.~/:@+\\-])(?:file:\/\/|~\/|\.{1,2}\/|\/(?=[\w.~@+-])|[\w@+-][\w.@+-]*\/)/g;

/** A path ends at a quote, a bracket, a tab or a table's border; a space may still be part of it. */
const STOP = /[\t'"\x60<>()[\]{}|│┃║]/;

const MAX = 512;

/** Answers for a few seconds, so moving over a line does not stat its paths again and again. */
const known = new Map<string, { len: number; at: number }>();
const FRESH_MS = 3000;

async function resolve(api: LisztApi, candidates: string[], cwd: string): Promise<number[]> {
  const now = Date.now();
  const lens = candidates.map((c) => {
    const k = known.get(`${cwd}\0${c}`);
    return k && now - k.at < FRESH_MS ? k.len : -1;
  });
  const ask = candidates.filter((_, i) => lens[i] < 0);
  if (ask.length) {
    const got = await api.resolvePaths(ask, cwd).catch(() => ask.map(() => 0));
    if (known.size > 2000) known.clear();
    let j = 0;
    lens.forEach((len, i) => {
      if (len >= 0) return;
      lens[i] = got[j++] ?? 0;
      known.set(`${cwd}\0${candidates[i]}`, { len: lens[i], at: now });
    });
  }
  return lens;
}

export function pathLinks(
  term: Terminal,
  api: LisztApi,
  cwd: () => string,
  activate: (e: MouseEvent, target: string) => void,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const { text, cells } = logicalLine(term, y);
      const starts: number[] = [];
      const candidates: string[] = [];
      for (const m of text.matchAll(START)) {
        let rest = text.slice(m.index, m.index + MAX);
        const stop = STOP.exec(rest);
        if (stop) rest = rest.slice(0, stop.index);
        rest = rest.trimEnd();
        if (rest.length < 2) continue;
        starts.push(m.index);
        candidates.push(rest);
      }
      if (!candidates.length) return callback(undefined);
      const dir = cwd();
      void resolve(api, candidates, dir).then((lens) => {
        const links: ILink[] = [];
        let taken = -1;
        lens.forEach((len, i) => {
          const from = starts[i];
          // A shorter path inside one already linked (`v2/exports` in `~/Creative Studio v2/exports`) is not another link.
          if (!len || from <= taken) return;
          taken = from + len - 1;
          const start = cells[from];
          const end = cells[taken];
          if (!start || !end || end.y < y || start.y > y) return;
          const target = candidates[i].slice(0, len);
          links.push({
            range: { start, end },
            text: target,
            decorations: { underline: true, pointerCursor: true },
            activate: (e) => activate(e, target),
          });
        });
        callback(links.length ? links : undefined);
      });
    },
  };
}
