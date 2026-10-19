import { contextBridge, ipcRenderer } from 'electron';
import type { EffortLevel, ModelInfo, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentSession,
  AppSession,
  AppState,
  ChatAnswer,
  ChatMessage,
  ChatAsk,
  ChatImage,
  GitInfo,
  GitResult,
  HookEvent,
  HostSession,
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
  chatSend: (id: string, text: string, images?: ChatImage[], uuid?: string) => ipcRenderer.send('chat:send', id, text, images, uuid),
  chatBash: (id: string, cwd: string, command: string): Promise<{ stdout: string; stderr: string; code: number }> =>
    ipcRenderer.invoke('chat:bash', id, cwd, command),
  chatFiles: (cwd: string): Promise<string[]> => ipcRenderer.invoke('chat:files', cwd),
  chatModels: (id: string): Promise<ModelInfo[]> => ipcRenderer.invoke('chat:models', id),
  chatModel: (id: string, model: string) => ipcRenderer.send('chat:model', id, model),
  chatEffort: (id: string, effort: EffortLevel) => ipcRenderer.send('chat:effort', id, effort),
  chatStopTask: (id: string, taskId: string) => ipcRenderer.send('chat:stop-task', id, taskId),
  chatRewind: (id: string, sessionId: string, cwd: string, index: number, files: boolean): Promise<{ ok: true; resumeAt: string | null; text: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('chat:rewind', id, sessionId, cwd, index, files),
  chatAnswer: (id: string, askId: string, a: ChatAnswer) => ipcRenderer.send('chat:answer', id, askId, a),
  chatInterrupt: (id: string) => ipcRenderer.send('chat:interrupt', id),
  chatMode: (id: string, mode: PermissionMode) => ipcRenderer.send('chat:mode', id, mode),
  chatHistory: (sessionId: string, cwd: string): Promise<ChatMessage[]> => ipcRenderer.invoke('chat:history', sessionId, cwd),
  chatTitle: (sessionId: string, cwd: string): Promise<string | undefined> => ipcRenderer.invoke('chat:title', sessionId, cwd),
  chatLive: (): Promise<HostSession[]> => ipcRenderer.invoke('chat:live'),
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
  onChatEvent: (cb: (id: string, m: Record<string, unknown>) => void) => on('chat:event', cb),
  onChatAsk: (cb: (id: string, a: ChatAsk) => void) => on('chat:ask', cb),
  onChatUnask: (cb: (id: string, askId: string) => void) => on('chat:unask', cb),
  onChatError: (cb: (id: string, text: string) => void) => on('chat:error', cb),
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
