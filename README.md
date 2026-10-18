# Liszt

A personal terminal that runs Claude Code sessions in project tabs and split panes.
Electron + xterm.js + node-pty. Every pane runs the real `claude` CLI; status comes from Claude
Code hooks.

```

                                     ..:!!!+sohoo@@CCCv.
                              -sohC@@OWW@OOWOOO@@@@@OO@O@h+.
                           ,soohCChhChCChCCChhhhoCCCCCC@@COOOo:
                         +soooh@C!!!vssooohhCCCC@@@@@O@@@CChCWOhv
                       sssoooohhv,+xxxssssoohhhhhCCC@CCC@OOO@@OO@h:.
                     ossooosss+!!vxoosxvv+vvxxvxshohChCCC@@@OO@C@O@-,
                   !ossoxxxvs+:+++vvxsssx+xxvsohhhhoh@@@@@@@@@OO@@OWx.
                  hosxxxssxs+!++!!!+vxshChhh@@OoC@O@oCC@@@OOOOOOOOC@OC+:
                 hov++!+vCs++vv+++!:!+shhossooo::@@OC!Co+vooooh@@sO@@OCx,
                ox+!!-!xhCv++v++::!:!xohoosxs+!+-!,+Cv+-  ..--,!CoxOOW@++
              .sxv++!!sx@v++v!----::+!!--::-,.,,. .+hCv.   ,!+:-+OsC@@Ox!v
              sxvxx!+x!+@v!:!-,-:-:,,,,-...-ss-:- .-oQQ!.,-:++xvoOW@@COs-!!
             :ss+sx,vv!hxv.+!:!-!:!:--.,.,-:xovxv--,-hQQhx++vs@@OQWOCOhx!!!
             sss!hs:vsssv:,+!::-!::+++!:++vvxvvsx+!!+xQQWWOChC@@OOO@hOxv+!+
            -sxx+ovx+sv++.,-::!.:!:!vooosooohC@Cv!!:+x@QQWO@QWO@hohChOC+!!
            oxv+xx+vxs!+,..,:,:::::::!+vxsohCCC+,vs!.:vhCO@x-h@Chshho@@x:!-
           ox++xo!+os!!!,,..,,,+-,-:::!!++vssx!..,.....,:+vv ,+CCoohsh@Oo:!!,
          oxvvss:!oxx::!..,..,,,,.,::::::!!!!!--,.,.::.!sCOhs:.-hohsxoh@Whv+!
        .sxxxx!:+xxvv:-,,...,.,,,-,,-::::!!,!+!:---,x! xxxv++x!+xxhxxsoh@W@o+!
        xvvx+-:svvvs!!:,-. .:,,:--,,-::-!+-:::,-,,--+x+xh@Co++xhhso+sxshhCOWh+
       xvxx!,vhv+voxv!:-.......-:-.,----+!!v!-:!!:!vssohC@OOWOvshCx:+xhsCCCWWC:
      :sxv+:vhs++osxv+:--,.....-,-,.,,--!:!++!!!!:::!!+xohC@@O@xoC++xvoohChC@Oo
      osxx!vhosvsossxv!--!:...:-!,.,,,--:-:!!::!+vxxoC@@QQQWOO@xshxxooxCoCCCO@C
      hox+!CsoooossCos+!,!+!. :v:+!,...,--,-:--!!+++vxv+xhChh@os@CxxCChhsOO@@h!
     oxxv+!+xohosxvooh+-!:+,.. :o+xos+-.......,,,--,:!::-!:+xhhohhohCCC@osoox:
     .x++!vvv++++!vv!-!-,-..... .+xvohCox+!:-....,,,..,+x.Chvohoxxohoshos-
        .x@x- .......  .. ......  .:!vsohCChhox+:...,+o@-Cs +!:,,:+vxxx++:
       .+-.  ......................  .-::+ohhohhCs,:xOW@Ws  .-!:.. .-+xsxxxx.
    -+,  .,,..........................  . .!xohChOQQQQQQ!-.   ,vs+:....:+vvxxxv.
 ++-..,--,,,....,....................... ..  .-voChox!, -x+.    :vsx+:...-!!+xsosvv
!--::::----,,,-,,....... ..............,. ...   .... .. ++vv:.   .+xxxxv!,,,-!+shx+x-
!!!!:::------,,,,-,,,... .,.............,, ........,-+.,v!+vv+:,. .!xxvxsx+!+s+-vh!+x!
!!:!::-:-----,.--,--,-..  .......,-,,,-,.,:..........,.:x+!+vvv++:. .+xxvxvvxxox:+v!+v+
---!!:--::-:--,,,,-,---....,.---:-::::-,:,,:-..,.-,,,.. ,++!+++vvvv!  ,vossssx+vhv+v!:x.
...-!!-.,----:-,.-,.,...,-,..---!!:-:!:--!:,-!,.,,-,-,-, -v::vxxv+vxx-  !soosoov,ohs+:x+
....,:!:....,-----,..,..,-,,.,-::::::!:-:-:!::+,.-,,,-:-. -x+!+vxx++vs:  ,+oossh! !Cvxvv+.
.. ...-:!.   .,:::--.,-  ,,,..,::!!!!:!!+!--!!+x,.,------- .vx++!+sxvvs!  .:sooohsvhv+svxx
........,!,  ...,::-. ,-.  ,-,,-:!:!!!!!!+!!!:!+o,.--------  +++v!-+svvx+.  -+sosoooo!+x++
```

<sub>Franz Liszt, photographed by Nadar in 1886 · Listen: [Hungarian Rhapsody No. 2](https://www.youtube.com/watch?v=E9S2CfDwNAg), played by György Cziffra</sub>

## Running

```bash
npm install
npm start
```

## Installing as an app

```bash
npm run dist:mac
ditto release/mac-arm64/Liszt.app /Applications/Liszt.app
```

- The package is for Apple Silicon and ad-hoc signed. Because it is built on the same Mac,
  Gatekeeper opens it without asking; copied to another Mac it needs right-click → Open on first launch.
- The icon is drawn by `scripts/make-icon.py` into `build/icon.png`.
- The development build (`npm start`) and the installed app share the same data folder, and only
  one of them can be open at a time.

## Shortcuts

| Shortcut | Action |
|---|---|
| ⌘T / ⇧⌘T | New Claude session / new shell (opens in the focused split) |
| ⌘D / ⇧⌘D | Open a new Claude session split to the right / below |
| ⌘W | Close the focused session |
| ⌃N | New project: a Claude session in `~/other-projects` that makes the project's folder (in any `~/*-projects`) and moves itself into its own tab |
| ⌘O / ⇧⌘W | Add project / close project |
| ⌘1…9, ⇧⌘] / ⇧⌘[ | Switch between projects |
| ⌘] / ⌘[ | Switch between session tabs |
| ⌘B | Toggle the Changes (git) panel |
| ⌘L | Toggle the Sessions panel (focuses the search box) |
| ⌘J | Toggle the Tasks panel |
| ⌘= / ⌘- / ⌘0 | Font size |
| ⇧↩ | New line in the Claude prompt |
| Double-click a title | Rename the session |
| Right-click a session tab or title | Session menu |
| Double-click a split divider | Make the splits equal size |

## Tabs and splits

- The top row holds projects; each project is a tab stack (as in Vivaldi). The open stack's
  sessions sit as tabs in the second row below. Background tabs keep running.
- Drag project tabs to reorder them; ⌘1…9 follows that order.
- Projects can be collected into named, colored **groups**, like browser tab groups. The group's
  colored label sits in front of its projects, and the projects are underlined in the group's color.
  - **Add to Group → New Group** in the project menu creates a group and lets you type its name
    right away; if the name is left empty the label is just a color. **Move to Group** moves the
    project to another group, **Remove from Group** moves it just to the right of the group.
  - Clicking the label collapses the group: only the label, the project count and the most urgent
    status dot of the hidden projects remain. If the open project is in that group, its tab stays visible.
  - Dragging: dropping a project among a group's projects adds it to that group, dropping it among
    ungrouped tabs takes it out. A project dropped on the right half of a label goes to the start of
    the group, on the left half it goes in front of the group. Dragging the label moves the whole group.
  - Right-clicking the label opens the group menu: **Rename…**, **Color**, **Collapse / Expand**,
    **Add Project to Group…** (asks for a folder; moves a folder that is already open into the group),
    **Ungroup** (the projects stay where they are) and **Close Group** (closes the group's projects).
    A group whose last project leaves disappears on its own.
- Context menus and dropdowns (Show / Sort in Sessions, Autopilot's `max`) are Liszt's own menus,
  not macOS menus. Arrow keys, Enter, Esc and type-to-jump work; while a menu is open, keys don't
  reach the terminal. Clicking outside closes the menu without reaching what was clicked;
  right-clicking somewhere else opens that spot's menu.
- Right-clicking a project tab opens the project menu:
  - **Rename…** edits the project name in place on the tab; Enter saves, Esc cancels. Clearing the
    name and saving, or **Use Folder Name**, goes back to the folder's name.
  - **Add to Group / Move to Group / Remove from Group**, as described above.
  - **Fold** collapses the tab: only its icon and status dot remain, and the name shows in a tooltip
    on hover. **Unfold** opens it again; **Fold Others** folds the other projects, **Unfold All** opens them all.
  - **Choose Icon… / Detect Icon Again**, **Reveal in Finder** and **Close Project**.
- Drag a session tab (or a split's title):
  - Drop it in the tab row to reorder.
  - Drop it in the middle of a terminal to take that terminal's place.
  - Drop it on the edge of a terminal to split toward that side.
- Right-clicking a session tab (or a split's title) opens the session menu:
  - **Rename…** edits the name in place on the tab; Enter saves, Esc cancels. Clearing the name and
    saving, or **Use Automatic Name**, goes back to the title Claude gave it.
  - **Rename with Claude** lets Claude Code name the session: it types `/rename` with no argument
    into the session, and the model looks at the conversation and comes up with a short name
    (like `fix-login-bug`). The name becomes the session's name in Claude Code (`/resume`,
    `claude agents`) and reaches the tab as the terminal title; it replaces any name set by hand in
    Liszt. If the model can't produce a name, nothing changes. It is only enabled when Claude has
    finished its turn and is waiting at the prompt. If there is a half-written draft in the prompt
    box, it is first stashed with Ctrl+S and Claude Code puts it back when the command finishes. If
    another draft is already stashed with Ctrl+S, Liszt types nothing so it doesn't overwrite it,
    and warns you. Nothing is typed either if the box is not on screen (a menu or question is open).
  - **Mark as Unread / Mark as Read** marks the session unread to come back to later, or clears the mark.
  - **Split Right / Split Down** places the session next to the focused split; **Take Out of Split**
    removes it from the split.
  - **Reveal in Finder**, **Copy Session ID** (for `claude --resume <id>`), **Close Session** and
    **Close Other Sessions**.
- When Claude finishes its reply while you are not looking at that session, the session becomes
  unread: the status dot turns from the Idle ring into a solid green dot, the tab title goes bold,
  the label says **Unread** and the project tab's dot turns green too. Switching to the session,
  clicking into it or typing in it marks it read; returning to the window does not. The mark is
  stored in `state.json` and survives a restart. A session that finished while Liszt was closed also
  shows as unread on launch.
- If Claude has finished its turn but background work it started is still going (for example a
  shell command run with `run_in_background`), the session doesn't count as finished: the label
  becomes a yellow **Waiting · 2m** and the dot turns into a yellow ring. The label's tooltip and
  the Sessions row say what is being waited on (`Waiting on shell · Run the test suite`). When the
  work is done Claude picks up where it left off; the notification and **Unread** only come once
  the last turn ends, and the task card stays In progress until then.
- Drag the divider between splits to resize them. The "take out" icon in a split's title removes
  the session from the split but keeps it running as a tab.
- Project icons are found in the project itself: Unity's app icon, Godot's `config/icon`, Xcode's
  `AppIcon`, Next.js `app/icon`, Tauri's `src-tauri/icons/icon.png`, `build/icon.png`, and
  `logo`/`favicon` files. If none is found, a symbol is drawn based on the project type. It can be
  picked by hand with **Choose Icon…** in the project menu.
- The left panel holds either Changes or **Sessions**, never both: opening one from the buttons at
  the top right (or ⌘B / ⌘L) closes the other.
- **Sessions** lists every Claude Code session on the machine under three headings:
  - **In Liszt**: Liszt's panes. Each row shows the status, the elapsed time and the last thing
    Claude did (for example `Edit · main.ts`).
  - **Running elsewhere**: sessions running outside Liszt — other terminals, the Claude desktop app
    and background sessions.
  - **Not running**: sessions no process is running. These are finished or stopped background
    sessions (for example the `agent1`, `agent2` agents from `/open-agents`), sessions kept by the
    Claude desktop app, and every other session whose transcript Claude Code still keeps: sessions
    that ran in a terminal and exited, ones the desktop app no longer lists, Agent SDK runs and
    closed Liszt panes. The row's subtitle says what ran the session (**Terminal**, **Claude app**,
    **Agent SDK**). Archived sessions (**Archived**) are here too.
- Pinned sessions sit at the top of their group with an orange pin in front of the name. Sessions
  pinned in the desktop app and in the `claude agents` view are both shown this way.
- The search box searches titles, projects, folders and status text; it ignores case and Turkish
  diacritics (`gecis` → "geçiş"). Enter opens the first result, Esc clears the box.
- **Show**: Active (everything that is not archived and can be opened, the default), In Liszt,
  Running, Unread, Pinned, Archived, All. Sessions whose folder or transcript has been deleted can't
  be opened; they only show under All.
  **Sort**: Status (those waiting on you first), Recent, Name, Project (groups under project headings).
- Clicking a row jumps to the Liszt pane. For an outside session, its folder is added as a project
  if it isn't one already, and the session opens in a new pane: a background session with
  `claude attach <id>` (woken up if it has finished, opening with its latest conversation), the
  rest with `claude --resume <sessionId>`. A session whose folder or transcript has been deleted
  appears dimmed and doesn't open.
- Right-clicking a row (or pressing the **⋯** button that appears on the right on hover) opens the
  session menu:
  - **Mark as Unread / Mark as Read** marks the session unread to come back to later, or clears the
    mark; it works for sessions outside Liszt too. An unread session moves to the top of its group
    with a green dot, a bold title and an **Unread** label (while it is working on something its
    status shows, and it becomes Unread again when the work is done). Opening the session marks it
    read. When an unread Liszt pane is closed, its session stays unread under Not running.
  - **Close Session** closes the session; the conversation is kept. If it is in a Liszt pane, the
    pane closes. A background session is stopped with `claude stop <id>`. For an interactive session
    running in another terminal or the desktop app, the process is terminated (SIGTERM); Liszt asks
    before doing that.
  - **Archive** archives the session, closing it first if it is running (**Close and Archive**). An
    archived session leaves Active, shows under **Archived**, and reopens when clicked.
    **Unarchive** undoes it. The archive belongs to Liszt: nothing is written to the desktop app's
    files. Liszt's choice takes precedence over the app's, so a session archived in the app can be
    unarchived in Liszt. An archived session's title and folder are saved; even if Claude Code
    cleans up its transcript, it stays under Not running as **Kept by Liszt**.
  - **Delete Session…** asks for confirmation, closes the session and moves its conversation
    (`~/.claude/projects/…/<sessionId>.jsonl` and the folder next to it) to the Trash. A background
    session is first deleted with `claude rm <id>`; if work would be lost, Claude Code keeps the
    worktree and says so. The desktop app keeps listing the session; Liszt hides it.

## How it works

- `src/main/main.ts`: the window, ptys, git queries, the menu and the hook server.
- Every Claude pane is a Claude Code background session. Liszt starts the session on Claude Code's
  background server with `claude --bg` (or `claude --bg --resume <sessionId>` for an ongoing
  conversation); the pane's terminal only runs `claude attach <id>`. That is why quitting with ⌘Q
  doesn't stop the sessions — they keep running, and on the next launch the panes reattach to the
  same sessions. These sessions are also listed as background sessions in the `claude agents` view.
- Claude Code won't start a background session in a folder it doesn't trust. In such a folder the
  pane runs claude directly with `claude --session-id <uuid>`; the trust question is asked there and
  the session closes along with the app. Once the folder is trusted, it moves to the background on
  the next launch. Shell panes also close with the app.
- Each pane gets its hooks (`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`,
  `PostToolUse`, `SessionEnd`) as inline `--settings` JSON, with the pane's id written into the
  command. This is because the background server runs sessions with its own environment, not the
  pane's. The hook sends the event to a token-protected server on `127.0.0.1`. It reads the address
  at that moment from `<userData>/hook-url` (a file only the user can read). That way sessions
  started during an earlier launch also reach the current Liszt; while Liszt is closed the file
  doesn't exist and the hook sends nothing. The pane labels (Running · 1m / Waiting · 1m / Needs you
  / Unread / Pushed / Merged / Idle) come from here. Pushed and Merged replace Idle on an idle
  session when the session made a successful `git push` or `gh pr merge` Bash call; they clear when
  a new prompt is sent. A reattached pane takes its status from the `claude agents` list until the
  first hook arrives. Sessions Liszt didn't start send no hooks; their status always comes from that list.
- A prompt typed while Claude is working waits in Claude Code's queue. If Claude doesn't pick it up
  between two tool calls, it starts a new turn once the current one ends. But its
  `UserPromptSubmit` arrives the moment it is typed, before the previous turn's `Stop`, and no hook
  announces the new turn. So a pane that looks Idle switches to Running when a tool runs
  (`PostToolUse`) or when `claude agents` lists the session as busy. The list is also polled 3
  seconds after every `Stop`, so this switch takes a few seconds. A turn caught only from the list
  is reverted if the list shows the session idle before any hook arrives.
- `<userData>/claude-settings.json` is only written so that sessions backgrounded by older versions
  can find it when they are woken up.
- Panes, projects and session ids are stored in `~/Library/Application Support/Liszt/state.json`.
  When the app reopens, panes reattach to their sessions with `claude attach <id>`. Sessions Claude
  Code no longer recognizes come back with `claude --bg --resume <id>`.
  Sessions archived, deleted or marked unread outside Liszt in Sessions are also kept here, by
  session id, under `sessionMarks`.
- Panes are only started when their project is first opened, so adding many projects doesn't slow
  down launch.
- The main process runs `claude agents --json --all` every 10 seconds and sends the list to the
  renderer. Entries that match a pane's session only show under In Liszt. Sessions pinned in the
  agents view are read from `~/.claude/jobs/pins.json`.
- In the same pass, the Claude desktop app's session files are read:
  `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json`. The title,
  folder, `cliSessionId` and `isArchived` come from there, and pinned sessions come from the
  `starred-local-code-sessions` list in `claude_desktop_config.json`. Liszt never writes to these
  files; each file is only reread when it changes.
- In the same pass, Claude Code's transcripts are scanned: `~/.claude/projects/<folder>/<sessionId>.jsonl`
  (or the equivalent under `CLAUDE_CONFIG_DIR`). Whoever started a session, its transcript is here,
  so sessions not listed anywhere else come from here. Since transcripts can be tens of MB, only the
  first and last 64 KB of each are read, and only when the file changes: the title (the `/rename`
  name, otherwise the title Claude gave, otherwise the first prompt) and the folder come from there.
  The session opens with `claude --resume` in the folder that matches where its transcript lives.
  Claude Code cleans up old transcripts itself (`cleanupPeriodDays`, 30 days by default); a cleaned-up
  session drops off the list too.
- If `/background` is typed in a pane running Claude directly, Claude Code moves the session to the
  background server (`--bg-pty-host`) under a new id, and the pane's process prints
  `backgrounded · <id>` and exits. Liszt catches that line and attaches the pane to that session;
  **Resume** then connects to it with `claude attach <id>`.
- When a pane (or its project) is closed, its session is stopped with `claude stop <id>`. The
  conversation isn't deleted: the session stays in Sessions under Not running as Stopped and comes
  back with `claude attach <id>` when clicked. **New session** also stops the pane's old session.
- The login shell environment (`.zprofile`, `.zshrc`) is read once, so panes see the terminal's
  PATH and variables even when the app is opened from Finder.

## Task board and Autopilot

- Type a card into the Tasks panel on the right and press Enter. Click the card to write extra
  details to send to Claude.
- **Start** launches the card:
  - Opens a new worktree under `<repo>/.claude/worktrees/<card-name>-xxxx` on the branch
    `liszt/<card-name>-xxxx`.
  - Opens a Claude pane in that worktree, starting with the card's text.
  - The folder is added to `.git/info/exclude` so it doesn't show up in the main repo's
    `git status`; `.gitignore` is left untouched.
- When Claude finishes its turn (the `Stop` hook), the card moves to **Review**. If you keep typing
  in the pane, the card goes back to **In progress**.
- **Done** closes the pane. The worktree stays on disk; **Remove worktree** in the Done list deletes
  it. Git refuses to delete it if there are uncommitted changes. The branch is always kept.
- With **Autopilot** on, the next Todo card starts on its own whenever the number of cards In
  progress drops below `max`. A card that can't start (for example a project that isn't a git repo)
  waits with a red error; Autopilot skips it and the card can be retried by hand with **Retry**.
- Since worktrees open inside the repo folder, they inherit Claude's folder trust from the repo.
  Once you have trusted a repo, Autopilot doesn't get stuck on the trust question.

## Developer notes

- `npm run typecheck`: type check. `npm run build`: produces the `dist/` output.
- `LISZT_USER_DATA=<folder>`: runs with a separate profile. `LISZT_DEBUG=1` logs incoming hooks,
  stopped background sessions and the reason a background session failed to start to the console.
  `LISZT_CAPTURE=<file.png>` takes a screenshot after a few seconds (`LISZT_CAPTURE_DELAY` ms,
  8000 by default) and quits the app.
  `LISZT_TEST_SCRIPT=<file.js>` runs a script after the page loads and prints the returned value
  as a `[test]` line.
- When trying out background sessions, only use sessions you opened with `claude --bg` for testing;
  clean them up with `claude stop <id>` and `claude rm <id>`.

## Next steps

1. Reordering cards by dragging, and showing the worktree diff on Review cards.
