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

type Cell = { x: number; y: number };

/** How close to the right edge a row must end for the next row to be read as its continuation. */
const SLACK = 6;

/**
 * Whether row text `b` carries on `a`: a program that wraps its own output (Claude Code does) breaks
 * a long line onto a new row, often indented, which the terminal does not mark as wrapped. `a` must
 * end near the right edge, so close that the next row's first word would not have fit after it.
 */
function continues(a: { text: string; cells: Cell[] }, b: { text: string }, cols: number): boolean {
  const end = a.text.trimEnd().length;
  const word = /^\s*(\S+)/.exec(b.text)?.[1];
  if (!end || !word) return false;
  return a.cells[end - 1].x + 1 + word.length > cols - SLACK;
}

/**
 * The text around row `y` with the rows a program wrapped itself joined back on, by a space where
 * the row broke, and the cell each character sits in (none for a joining space).
 */
function paragraph(term: Terminal, y: number): { text: string; cells: (Cell | undefined)[]; joints: number[] } {
  const rows = term.buffer.active.length;
  const parts = [logicalLine(term, y)];
  for (let i = 0; i < 3; i++) {
    const top = parts[0].cells[0]?.y;
    if (!top || top <= 1) break;
    const prev = logicalLine(term, top - 1);
    if (!continues(prev, parts[0], term.cols)) break;
    parts.unshift(prev);
  }
  for (let i = 0; i < 3; i++) {
    const bottom = parts[parts.length - 1].cells.at(-1)?.y;
    if (!bottom || bottom >= rows) break;
    const next = logicalLine(term, bottom + 1);
    if (!continues(parts[parts.length - 1], next, term.cols)) break;
    parts.push(next);
  }
  if (parts.length === 1) return { ...parts[0], joints: [] };
  let text = '';
  const cells: (Cell | undefined)[] = [];
  const joints: number[] = [];
  parts.forEach((p, i) => {
    const from = i ? p.text.length - p.text.trimStart().length : 0;
    const to = i < parts.length - 1 ? p.text.trimEnd().length : p.text.length;
    if (i) {
      joints.push(text.length);
      text += ' ';
      cells.push(undefined);
    }
    text += p.text.slice(from, to);
    cells.push(...p.cells.slice(from, to));
  });
  return { text, cells, joints };
}

export function pathLinks(
  term: Terminal,
  api: LisztApi,
  cwd: () => string,
  activate: (e: MouseEvent, target: string) => void,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const { text, cells, joints } = paragraph(term, y);
      // Each place a path may start, with the text it may run to: as printed, and, where it crosses a
      // row the program broke, also without the joining space (a long name broken mid-word).
      const found: { from: number; tries: { text: string; at: number[] }[] }[] = [];
      const candidates: string[] = [];
      for (const m of text.matchAll(START)) {
        let rest = text.slice(m.index, m.index + MAX);
        const stop = STOP.exec(rest);
        if (stop) rest = rest.slice(0, stop.index);
        rest = rest.trimEnd();
        if (rest.length < 2) continue;
        const at = Array.from({ length: rest.length }, (_, i) => m.index + i);
        const tries = [{ text: rest, at }];
        const inside = at.filter((i) => joints.includes(i));
        if (inside.length) {
          const kept = at.filter((i) => !inside.includes(i));
          tries.push({ text: kept.map((i) => text[i]).join(''), at: kept });
        }
        found.push({ from: m.index, tries });
        for (const t of tries) candidates.push(t.text);
      }
      if (!candidates.length) return callback(undefined);
      const dir = cwd();
      void resolve(api, candidates, dir).then((lens) => {
        const links: ILink[] = [];
        let taken = -1;
        let k = 0;
        for (const { from, tries } of found) {
          // The reading that names the longest path on disk.
          let best: { text: string; at: number[] } | undefined;
          let len = 0;
          for (const t of tries) {
            const l = lens[k++];
            if (l > len) [best, len] = [t, l];
          }
          // A shorter path inside one already linked (`v2/exports` in `~/Creative Studio v2/exports`) is not another link.
          if (!best || from <= taken) continue;
          taken = best.at[len - 1];
          const start = cells[best.at[0]];
          const end = cells[taken];
          if (!start || !end || end.y < y || start.y > y) continue;
          const target = best.text.slice(0, len);
          links.push({
            range: { start, end },
            text: target,
            decorations: { underline: true, pointerCursor: true },
            activate: (e) => activate(e, target),
          });
        }
        callback(links.length ? links : undefined);
      });
    },
  };
}
