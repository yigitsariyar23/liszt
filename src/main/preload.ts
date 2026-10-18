import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentSession,
  AppSession,
  AppState,
  GitInfo,
  GitResult,
  HookEvent,
  MoveResult,
  NotifyKind,
  ProjectIcon,
  SpawnOptions,
  SpawnResult,
  TranscriptSession,
  WorktreeResult,
} from '../shared/types';

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void) {
  ipcRenderer.on(channel, (_e, ...args) => cb(...(args as A)));
}

const api = {
  loadState: (): Promise<AppState | null> => ipcRenderer.invoke('state:load'),
  saveState: (s: AppState) => ipcRenderer.send('state:save', s),
  spawn: (o: SpawnOptions): Promise<SpawnResult> => ipcRenderer.invoke('pty:spawn', o),
  write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
  resize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id: string) => ipcRenderer.send('pty:kill', id),
  stopBackground: (sessionId: string, bgId?: string) => ipcRenderer.send('agents:stop', sessionId, bgId),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  gitInfo: (cwd: string): Promise<GitInfo> => ipcRenderer.invoke('git:info', cwd),
  addWorktree: (project: string, title: string): Promise<WorktreeResult> => ipcRenderer.invoke('worktree:add', project, title),
  removeWorktree: (project: string, dir: string): Promise<GitResult> => ipcRenderer.invoke('worktree:remove', project, dir),
  projectIcon: (dir: string): Promise<ProjectIcon> => ipcRenderer.invoke('project:icon', dir),
  pickIcon: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickIcon'),
  closeSession: (sessionId: string, bgId?: string): Promise<GitResult> => ipcRenderer.invoke('sessions:close', sessionId, bgId),
  moveSession: (sessionId: string, bgId: string | undefined, to: string): Promise<MoveResult> =>
    ipcRenderer.invoke('sessions:move', sessionId, bgId, to),
  newProjectFolder: (): Promise<string> => ipcRenderer.invoke('projects:incubator'),
  deleteSession: (sessionId: string, bgId?: string): Promise<GitResult> => ipcRenderer.invoke('sessions:delete', sessionId, bgId),
  reveal: (dir: string) => ipcRenderer.send('shell:reveal', dir),
  copy: (text: string) => ipcRenderer.send('clipboard:write', text),
  openExternal: (url: string) => ipcRenderer.send('open:external', url),
  notify: (n: { title: string; body: string; paneId: string; kind: NotifyKind }) => ipcRenderer.send('notify', n),
  setBadge: (text: string) => ipcRenderer.send('badge', text),
  onData: (cb: (id: string, data: string) => void) => on('pty:data', cb),
  onExit: (cb: (id: string, code: number) => void) => on('pty:exit', cb),
  onBackground: (cb: (id: string, bgId: string) => void) => on('pty:background', cb),
  onHook: (cb: (ev: HookEvent) => void) => on('hook', cb),
  onAgents: (cb: (list: AgentSession[], asked: number) => void) => on('agents', cb),
  onAppSessions: (cb: (list: AppSession[]) => void) => on('app-sessions', cb),
  onTranscriptSessions: (cb: (list: TranscriptSession[]) => void) => on('transcript-sessions', cb),
  onMoveRequest: (cb: (paneId: string, dir: string) => void) => on('move-request', cb),
  onMenu: (cb: (command: string) => void) => on('menu', cb),
  onFocusPane: (cb: (id: string) => void) => on('focus-pane', cb),
};

contextBridge.exposeInMainWorld('liszt', api);

export type LisztApi = typeof api;
