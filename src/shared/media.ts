// Images and videos Liszt opens in its own viewer: local files named in a terminal or a chat, and
// web addresses that point straight at one.

/** The scheme the window loads local media from; the page itself may not read file: addresses. */
export const MEDIA_SCHEME = 'liszt-media';

/** Only what Chromium can show. */
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
};

const EXTS = Object.keys(TYPES).join('|');

/** The media type of a path or address by its extension, or undefined when it is not media. */
export function mediaType(target: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(target.split(/[?#]/)[0])?.[1];
  return ext ? TYPES[ext.toLowerCase()] : undefined;
}

export const mediaKind = (target: string): 'image' | 'video' | undefined => {
  const type = mediaType(target);
  return type ? (type.startsWith('video/') ? 'video' : 'image') : undefined;
};

export const isWebUrl = (s: string) => /^https?:\/\//i.test(s);

/**
 * A local media path in text, ending in a media extension: absolute, from home (`~/`), a file:
 * address, or relative to the session's folder (`outputs/a.mp4`, `./a.png`; a bare file name stays
 * plain text, it is too often just a name, and so does `example.com/a.png`). Not a piece of a longer path or address, and a
 * sentence's closing period stays out.
 */
const PATH_CHARS = String.raw`[^\s'"\x60<>()[\]{}|]*`;
export const MEDIA_PATH = new RegExp(
  String.raw`(?<![\w.~/:@+-])(?:(?:file://)?~?/${PATH_CHARS}|(?:\.\.?/)+${PATH_CHARS}|(?![\w-]+\.[a-z]{2,}/)[\w@+-][\w.@+-]*/[^\s'"\x60<>()[\]{}|:]*)\.(?:${EXTS})(?![\w/-])(?!\.\w)`,
  'gi',
);

/**
 * The path a file: address or a path names; a relative one is taken from `cwd`. `~` stays for the
 * main process to expand.
 */
export function localPath(target: string, cwd?: string): string {
  let p = target;
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(p.slice('file://'.length));
    } catch {
      p = p.slice('file://'.length);
    }
  }
  if (!cwd || p.startsWith('/') || p.startsWith('~')) return p;
  const parts = cwd.split('/');
  for (const seg of p.split('/')) {
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
    } else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/') || '/';
}

/** The address the window loads a local file from. `~/a.png` travels as `/~/a.png`. */
export function mediaUrl(file: string): string {
  const p = file.startsWith('~') ? `/${file}` : file;
  return `${MEDIA_SCHEME}://local${p.split('/').map(encodeURIComponent).join('/')}`;
}
