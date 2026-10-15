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
  /**
   * Claude had work under way when Liszt last saw it. A background session keeps going after Liszt
   * quits; found idle on the next start, it finished meanwhile and its reply is unread.
   */
  working?: boolean;
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

export type GroupColor = 'grey' | 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'purple' | 'cyan';

/** A named run of project tabs in the top bar, like a browser's tab group. */
export interface ProjectGroup {
  id: string;
  /** May be empty; the group's tab then shows only its colour. */
  name: string;
  color: GroupColor;
  /** Only the group's tab shows, plus the open project when it is one of the group's. */
  collapsed?: boolean;
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
  /** Its group's projects always sit next to each other in `AppState.projects`. */
  groupId?: string;
  tasks: TaskState[];
  autopilot: AutopilotState;
}

export interface AppState {
  version: 1;
  projects: ProjectState[];
  /** Project tab groups; they are ordered by where their projects sit. */
  groups: ProjectGroup[];
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

/** A session archived, unarchived, deleted or marked unread from the Sessions panel. */
export interface SessionMark {
  /** Liszt's choice, which wins over the Claude app's: false keeps one the app archived out of Archived. */
  archived?: boolean;
  /** Its row stays hidden unless something runs the session again. */
  deleted?: boolean;
  /** Unread while no Liszt pane has the session: marked so from its row, or its pane closed unread. Opening it reads it. */
  unread?: boolean;
  /** Its work went out: pushed to the remote, or its pull request merged. Cleared by the next prompt. */
  shipped?: 'pushed' | 'merged';
  /** Kept on archiving: a closed Liszt pane or an interactive session is listed nowhere else. */
  title?: string;
  cwd?: string;
  /** When it was closed by archiving, or first marked when it never was. */
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
 * `bgId` is the background session the pane attached to; without it the pane runs claude itself.
 */
export type SpawnResult = { ok: true; sessionId: string; resumed: boolean; bgId?: string } | { ok: false; error: string };

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
  /** `waiting`: stopped on a permission or a question in the middle of a turn. */
  status: 'idle' | 'busy' | 'waiting';
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

/** A Claude Code session found by its transcript, which Claude Code keeps whatever ran the session. */
export interface TranscriptSession {
  sessionId: string;
  /** Its name in Claude Code, else what it was first asked. */
  title: string;
  /** The folder it ran in, the one `claude --resume` finds it from. */
  cwd: string;
  /** What ran it: `cli` (a terminal, Liszt's panes included), `claude-desktop`, `sdk-cli`… */
  entrypoint?: string;
  lastActivityAt: number;
  /** Its folder no longer exists, so it cannot be resumed. */
  gone?: boolean;
}

export type SidebarView = 'changes' | 'sessions';

export type SessionFilter = 'active' | 'liszt' | 'running' | 'unread' | 'pinned' | 'archived' | 'all';

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
  /** PostToolUse of Bash: the command as Claude ran it. */
  command?: string;
  /** Stop: background tasks still running, which start another turn when they finish. */
  tasks?: BackgroundTask[];
}

/** A background shell command, subagent or monitor a session started, as its Stop hook lists it. */
export interface BackgroundTask {
  /** `shell` for a background command. */
  type: string;
  /** What it does, in Claude's words or as the command itself. */
  label: string;
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
