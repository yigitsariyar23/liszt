import type { IBufferCell, ILinkProvider, Terminal } from '@xterm/xterm';
import type { LisztApi } from '../main/preload';
import { MEDIA_PATH, isWebUrl, localPath, mediaKind, mediaUrl } from '../shared/media';
import { h } from './dom';

// The media viewer: an image or a video from a terminal or a chat, over the whole window.

let viewerEl: HTMLElement | null = null;
let restoreFocus: HTMLElement | null = null;

function close() {
  if (!viewerEl) return;
  viewerEl.querySelector('video')?.pause();
  viewerEl.remove();
  viewerEl = null;
  restoreFocus?.focus();
  restoreFocus = null;
}

// Esc closes the viewer before a pane or the sidebar gets the key.
window.addEventListener(
  'keydown',
  (e) => {
    if (!viewerEl || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  },
  true,
);

/**
 * Shows a local path, a file: address or a web address of an image or video. A relative path is
 * taken from `cwd`, the folder of the session that printed it.
 */
export function openMedia(api: LisztApi, target: string, cwd?: string) {
  const kind = mediaKind(target);
  if (!kind) return;
  close();
  const web = isWebUrl(target);
  const file = web ? '' : localPath(target, cwd);
  const src = web ? target : mediaUrl(file);

  const el = h('div', 'media-viewer');
  el.tabIndex = -1;
  const bar = h('div', 'media-bar');
  const name = h('span', 'media-name', web ? target : file);
  name.title = name.textContent ?? '';
  const open = h('button', 'media-btn', 'Open');
  open.title = web ? 'Open in the browser' : 'Open in the default app';
  open.addEventListener('click', () => (web ? api.openExternal(target) : api.openPath(file)));
  bar.append(name, open);
  if (!web) {
    const reveal = h('button', 'media-btn', 'Show in Finder');
    reveal.addEventListener('click', () => api.reveal(file));
    bar.append(reveal);
  }
  const closeBtn = h('button', 'media-btn', 'Close');
  closeBtn.title = 'Close (Esc)';
  closeBtn.addEventListener('click', close);
  bar.append(closeBtn);

  const stage = h('div', 'media-stage');
  const media = kind === 'video' ? h('video') : h('img');
  if (media instanceof HTMLVideoElement) {
    media.controls = true;
    media.autoplay = true;
  }
  media.addEventListener('error', () => stage.replaceChildren(h('div', 'media-error', `Could not open ${web ? target : file}`)));
  media.src = src;
  stage.append(media);
  // A click beside the picture closes it; one on the picture or its controls does not.
  stage.addEventListener('click', (e) => e.target === stage && close());

  el.append(bar, stage);
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.append(el);
  viewerEl = el;
  el.focus();
}

/** Whether a link should go to the viewer rather than the browser. */
export const opensInViewer = (target: string) => Boolean(mediaKind(target));

/**
 * Makes local image and video paths in a terminal clickable, also when a long one wraps onto the
 * next rows.
 */
export function mediaLinks(term: Terminal, activate: (target: string) => void): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      let first = y - 1;
      while (first > 0 && buf.getLine(first)?.isWrapped) first--;
      let last = y - 1;
      while (buf.getLine(last + 1)?.isWrapped) last++;
      // The logical line's text, and the cell each of its characters sits in.
      let text = '';
      const cells: { x: number; y: number }[] = [];
      let cell: IBufferCell | undefined;
      for (let row = first; row <= last; row++) {
        const line = buf.getLine(row);
        if (!line) break;
        for (let x = 0; x < line.length; x++) {
          cell = line.getCell(x, cell);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ';
          text += chars;
          for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: row + 1 });
        }
      }
      const links = [];
      for (const m of text.matchAll(MEDIA_PATH)) {
        const start = cells[m.index];
        const end = cells[m.index + m[0].length - 1];
        if (!start || !end || end.y < y || start.y > y) continue;
        const target = m[0];
        links.push({ range: { start, end }, text: target, activate: () => activate(target) });
      }
      callback(links.length ? links : undefined);
    },
  };
}

/** Turns the local media paths in rendered markdown into links the chat opens in the viewer. */
export function linkMediaPaths(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.parentElement?.closest('a') ?? null) && n.textContent && /\.\w/.test(n.textContent)) found.push(n as Text);
  }
  for (const node of found) {
    const text = node.textContent!;
    const parts: (string | HTMLElement)[] = [];
    let at = 0;
    for (const m of text.matchAll(MEDIA_PATH)) {
      parts.push(text.slice(at, m.index));
      const a = h('a', 'media-link', m[0]);
      a.href = '#';
      a.dataset.media = m[0];
      parts.push(a);
      at = m.index + m[0].length;
    }
    if (!at) continue;
    parts.push(text.slice(at));
    node.replaceWith(...parts);
  }
}
