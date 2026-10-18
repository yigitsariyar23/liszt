import { BrowserWindow, Notification, app, ipcMain, screen, shell } from 'electron';
import type { WebContents } from 'electron';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NotifyKind, NotifyPrefs } from '../shared/types';

// A session that wants input or has finished is announced on several channels, each switched on its
// own from the Notifications menu. Notification Center is only one of them: an unsigned build often
// gets no banner there at all, so Liszt also draws its own, plays a sound and bounces the Dock.

export interface Note {
  title: string;
  body: string;
  paneId: string;
  kind: NotifyKind;
}

const DEFAULT_PREFS: NotifyPrefs = { banner: true, system: false, sound: true, dock: true };
const SOUNDS: Record<NotifyKind, string> = {
  attention: '/System/Library/Sounds/Glass.aiff',
  done: '/System/Library/Sounds/Hero.aiff',
};
/** How long a banner stays when the pointer is not on it; one asking for input stays longer. */
const BANNER_MS: Record<NotifyKind, number> = { attention: 20_000, done: 8_000 };
const BANNER_W = 380;
const BANNER_H = 92;
const BANNER_GAP = 6;
const MAX_BANNERS = 4;

const prefsPath = () => path.join(app.getPath('userData'), 'notify.json');
let prefs: NotifyPrefs = { ...DEFAULT_PREFS };

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    prefs = { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) };
  } catch {
    prefs = { ...DEFAULT_PREFS };
  }
  return prefs;
}

export const notifyPrefs = () => prefs;

export function setNotifyPref(key: keyof NotifyPrefs, on: boolean) {
  prefs = { ...prefs, [key]: on };
  fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2));
}

/** Announces a note on every channel that is on; `open` brings its pane forward. */
export function notify(note: Note, main: BrowserWindow | null, open: (paneId: string) => void) {
  if (prefs.sound) playSound(note.kind);
  if (prefs.banner) showBanner(note, open);
  if (prefs.system) showSystem(note, open);
  if (prefs.dock && !main?.isFocused()) app.dock?.bounce(note.kind === 'attention' ? 'critical' : 'informational');
}

function playSound(kind: NotifyKind) {
  execFile('afplay', [SOUNDS[kind]], (err) => err && shell.beep());
}

function showSystem(note: Note, open: (paneId: string) => void) {
  if (!Notification.isSupported()) return;
  // The sound channel plays its own; Notification Center's would only double it.
  const n = new Notification({ title: note.title, body: note.body, silent: prefs.sound });
  n.on('click', () => open(note.paneId));
  n.on('failed', (_e, error) => console.error('[notify] Notification Center refused the note:', error));
  n.show();
}

// --- Liszt's own banners -----------------------------------------------------------------------

interface Banner {
  win: BrowserWindow;
  note: Note;
  timer?: NodeJS.Timeout;
}

const banners: Banner[] = [];
let bannerOpen: (paneId: string) => void = () => {};

function showBanner(note: Note, open: (paneId: string) => void) {
  bannerOpen = open;
  // A newer word on the same session replaces the older one.
  for (const b of banners.filter((b) => b.note.paneId === note.paneId)) closeBanner(b);
  while (banners.length >= MAX_BANNERS) closeBanner(banners[0]);
  const win = new BrowserWindow({
    width: BANNER_W,
    height: BANNER_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    type: 'panel',
    webPreferences: { preload: path.join(__dirname, 'banner-preload.js') },
  });
  // Above full-screen apps and on every Space, so it is seen wherever the user is. A panel gets there
  // on its own; Electron's process-type switch for it would take Liszt out of the Dock for a moment,
  // and the running dot under its icon often does not come back.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  const banner: Banner = { win, note };
  banners.push(banner);
  layoutBanners();
  win.once('ready-to-show', () => {
    win.showInactive();
    arm(banner);
  });
  win.on('closed', () => {
    clearTimeout(banner.timer);
    const i = banners.indexOf(banner);
    if (i >= 0) banners.splice(i, 1);
    layoutBanners();
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bannerHtml(note))}`);
}

function arm(b: Banner) {
  clearTimeout(b.timer);
  b.timer = setTimeout(() => closeBanner(b), BANNER_MS[b.note.kind]);
}

function closeBanner(b: Banner) {
  if (!b.win.isDestroyed()) b.win.close();
}

/** Stacks the banners down the top-right corner of the screen the pointer is on, newest last. */
function layoutBanners() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  banners.forEach((b, i) => {
    if (b.win.isDestroyed()) return;
    b.win.setBounds({
      x: workArea.x + workArea.width - BANNER_W - 8,
      y: workArea.y + 8 + i * (BANNER_H + BANNER_GAP),
      width: BANNER_W,
      height: BANNER_H,
    });
  });
}

const bannerOf = (sender: WebContents) => banners.find((b) => !b.win.isDestroyed() && b.win.webContents === sender);

ipcMain.on('banner', (e, action: 'open' | 'dismiss' | 'hold' | 'release') => {
  const b = bannerOf(e.sender);
  if (!b) return;
  switch (action) {
    case 'open':
      bannerOpen(b.note.paneId);
      return closeBanner(b);
    case 'dismiss':
      return closeBanner(b);
    case 'hold':
      return clearTimeout(b.timer);
    case 'release':
      return arm(b);
  }
});

/** Banners for a pane the user has just looked at have said what they had to. */
export function dismissBanners(paneId: string) {
  for (const b of banners.filter((b) => b.note.paneId === paneId)) closeBanner(b);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function bannerHtml(note: Note): string {
  const attention = note.kind === 'attention';
  const color = attention ? '#e86fc0' : '#a3d46a';
  const label = attention ? 'Needs your input' : 'Finished';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; }
  body { padding: 4px; box-sizing: border-box; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; }
  .card {
    position: relative; height: 100%; box-sizing: border-box; display: flex; gap: 10px; padding: 10px 30px 10px 12px;
    background: rgba(24, 24, 27, 0.97); color: #d8d8dc; border: 1px solid #35353c; border-left: 3px solid ${color};
    border-radius: 10px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45); cursor: pointer;
    animation: in 180ms ease-out;
  }
  .card:hover { background: rgba(32, 32, 37, 0.98); }
  @keyframes in { from { transform: translateX(24px); opacity: 0; } }
  .dot { flex: none; width: 9px; height: 9px; margin-top: 4px; border-radius: 50%; background: ${color};
    ${attention ? 'animation: pulse 1.2s ease-in-out infinite;' : ''} }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .label { font-size: 11px; font-weight: 600; letter-spacing: 0.02em; color: ${color}; }
  .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .body { color: #a1a1aa; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .close { position: absolute; top: 6px; right: 8px; width: 18px; height: 18px; border: 0; padding: 0;
    background: none; color: #7f7f88; font-size: 15px; line-height: 18px; border-radius: 4px; cursor: pointer; }
  .close:hover { color: #d8d8dc; background: #35353c; }
</style></head><body>
<div class="card" id="card">
  <span class="dot"></span>
  <div class="text">
    <span class="label">${label}</span>
    <span class="title">${escape(note.title)}</span>
    <span class="body">${escape(note.body)}</span>
  </div>
  <button class="close" id="close" title="Dismiss">×</button>
</div>
<script>
  const card = document.getElementById('card');
  card.addEventListener('click', (e) => window.banner.act(e.target.id === 'close' ? 'dismiss' : 'open'));
  card.addEventListener('mouseenter', () => window.banner.act('hold'));
  card.addEventListener('mouseleave', () => window.banner.act('release'));
</script>
</body></html>`;
}
