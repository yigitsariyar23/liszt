export type PaneKind = 'claude' | 'shell';

export interface PaneState {
  id: string;
  kind: PaneKind;
  /** Claude session id; only meaningful once `started` is true. */
  sessionId: string;
  /** True once a prompt was sent, so the session has a transcript and can be resumed. */
  started: boolean;
  /** Claude's transcript file for the session, as its hooks report it. */
  transcript?: string;
  /** Title set by the terminal (Claude names its task) or the first prompt. */
  title: string;
  /** Title the user typed; wins over `title`. */
  customTitle?: string;
  /** Working directory when it is not the project folder (a task's worktree). */
  cwd?: string;
  /** Task this pane works on. */
  taskId?: string;
  /** Worktree branch, shown in the pane header. */
  branch?: string;
  /** Short id of the Claude Code background session this pane opens with `claude attach`. */
  bgId?: string;
  /** Claude finished a turn while the user was elsewhere, or the user marked the session unread. */
  unread?: boolean;
}

export type TaskStatus = 'todo' | 'doing' | 'review' | 'done';

export interface TaskState {
  id: string;
  title: string;
  body?: string;
  status: TaskStatus;
  createdAt: number;
  paneId?: string;
  /** Worktree root, used to remove it. */
  worktree?: string;
  /** Folder the task's Claude runs in: the project folder's counterpart inside the worktree. */
  cwd?: string;
  branch?: string;
  /** Claude session of the task, kept so a closed pane can be resumed. */
  sessionId?: string;
  /** Why the last start failed; Autopilot skips the card until it is started by hand. */
  error?: string;
}

export interface AutopilotState {
  on: boolean;
  /** Most tasks Autopilot keeps in progress at once. */
  limit: number;
}

export type ProjectKind = 'unity' | 'godot' | 'apple' | 'node' | 'python' | 'rust' | 'go' | 'folder';

export interface ProjectIcon {
  kind: ProjectKind;
  /** Data URL of the project's own icon, when one was found or chosen. */
  image?: string;
  /** Chosen by hand; never replaced by detection. */
  custom?: boolean;
}

/** What a session's right-click menu offers; main builds the menu from it. */
export interface SessionMenuOptions {
  claude: boolean;
  /** Named by the user, so it can go back to the automatic title. */
  renamed: boolean;
  /** Can be tiled next to the focused session. */
  canSplit: boolean;
  /** Shares the stage with other tiles. */
  inSplit: boolean;
  /** Has a transcript, so its session id can be resumed elsewhere. */
  started: boolean;
  /** The project has other sessions. */
  others: boolean;
  unread: boolean;
}

/** What a Sessions panel row's right-click menu offers. */
export interface SessionRowMenuOptions {
  /** Sits in a Liszt pane, so the first item shows it instead of opening it. */
  inLiszt: boolean;
  /** False when its folder or its conversation is gone. */
  canOpen: boolean;
  /** Runs somewhere, or sits in a Liszt pane, so there is something to close. */
  canClose: boolean;
  archived: boolean;
}

/** What a project tab's right-click menu offers. */
export interface ProjectMenuOptions {
  /** Named by the user, so it can go back to the folder name. */
  renamed: boolean;
  folded: boolean;
  /** Some other project tab is still unfolded. */
  othersUnfolded: boolean;
  /** Some project tab is folded. */
  anyFolded: boolean;
}

/** How a project's visible sessions are tiled: a tree of splits with session panes as leaves. */
export type LayoutNode =
  | { type: 'pane'; paneId: string }
  | { type: 'split'; dir: 'row' | 'column'; children: LayoutNode[]; sizes: number[] };

export interface ProjectState {
  id: string;
  /** The folder name unless the user renamed the project. */
  name: string;
  path: string;
  /** Sessions in tab order; the ones in `layout` are visible, the rest are background tabs. */
  panes: PaneState[];
  layout: LayoutNode | null;
  activePaneId?: string;
  icon?: ProjectIcon;
  /** The tab shows only its icon and status. */
  folded?: boolean;
  tasks: TaskState[];
  autopilot: AutopilotState;
}

export interface AppState {
  version: 1;
  projects: ProjectState[];
  activeProjectId: string | null;
  /** What the left panel shows, Changes or Sessions, never both; null when it is closed. */
  sidebar: SidebarView | null;
  tasksPanel: boolean;
  fontSize: number;
  sessionFilter: SessionFilter;
  sessionSort: SessionSort;
  /** What was done to sessions from the Sessions panel, by Claude session id. */
  sessionMarks: Record<string, SessionMark>;
}

/** A session archived, unarchived or deleted from the Sessions panel. */
export interface SessionMark {
  /** Liszt's choice, which wins over the Claude app's: false keeps one the app archived out of Archived. */
  archived?: boolean;
  /** Its row stays hidden unless something runs the session again. */
  deleted?: boolean;
  /** Kept on archiving: a closed Liszt pane or an interactive session is listed nowhere else. */
  title?: string;
  cwd?: string;
  /** When it was closed by archiving. */
  at: number;
}

export interface SpawnOptions {
  paneId: string;
  cwd: string;
  kind: PaneKind;
  sessionId: string;
  resume: boolean;
  cols: number;
  rows: number;
  /** First prompt for a new Claude session. */
  prompt?: string;
  /** Transcript of the session to resume; when it is gone a new session starts instead. */
  transcript?: string;
  /** Background session to open with `claude attach`; resumed by `sessionId` once it is no longer running. */
  attach?: string;
}

/**
 * `sessionId` and `resumed` say what actually started, which differs when a resume was not possible.
 * `attached` is true when the pane opened a running background session.
 */
export type SpawnResult = { ok: true; sessionId: string; resumed: boolean; attached: boolean } | { ok: false; error: string };

/** A Claude Code session on this machine, as `claude agents --json` lists it. */
export interface AgentSession {
  sessionId: string;
  /** Short id of a background session, the one `claude attach` and `claude stop` take. */
  id?: string;
  /** The process of an interactive session, ended to close it. */
  pid?: number;
  kind: 'interactive' | 'background';
  name: string;
  cwd: string;
  status: 'idle' | 'busy';
  /** Background sessions only, e.g. `blocked` while waiting for a prompt or a permission. */
  state?: string;
  /** A background session Claude Code no longer runs (done or stopped); `claude attach` wakes it. */
  ended?: boolean;
  /** Pinned in Claude Code's agent view. */
  pinned?: boolean;
  startedAt: number;
}

/** A Claude Code session the Claude desktop app keeps, running or not, archived ones included. */
export interface AppSession {
  /** The app's own id (`local_…`). */
  id: string;
  /** Claude Code session id, the one `claude --resume` takes. */
  sessionId: string;
  title: string;
  /** Folder to open it in: where it ran, or the folder it started from when that one is gone. */
  cwd: string;
  archived: boolean;
  /** Pinned in the app's sidebar. */
  pinned: boolean;
  lastActivityAt: number;
  /** Why it cannot be opened: its folder or its transcript no longer exists. */
  gone?: 'folder' | 'transcript';
}

export type SidebarView = 'changes' | 'sessions';

export type SessionFilter = 'active' | 'liszt' | 'running' | 'pinned' | 'archived' | 'all';

export type SessionSort = 'status' | 'recent' | 'name' | 'project';

/** A Claude Code hook payload, trimmed to the fields the UI uses. */
export interface HookEvent {
  paneId: string;
  event: string;
  sessionId?: string;
  transcriptPath?: string;
  source?: string;
  prompt?: string;
  message?: string;
  /** PostToolUse: the tool and a short description of what it touched. */
  tool?: string;
  detail?: string;
}

export interface GitFile {
  code: string;
  path: string;
}

export interface GitCommit {
  hash: string;
  when: string;
  subject: string;
}

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files?: GitFile[];
  commits?: GitCommit[];
}

export type WorktreeResult = { ok: true; dir: string; cwd: string; branch: string } | { ok: false; error: string };

export type GitResult = { ok: true } | { ok: false; error: string };
