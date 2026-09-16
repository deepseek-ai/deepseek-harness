# Agent Note: Web sidebar terminals

Status: implemented

English | [中文](2026-09-09-web-sidebar-terminal.zh.md)

## Problem

Web users need an interactive shell beside a Session to inspect the workspace and run commands. The Agent's persistent terminal tools control prompts and wait for semantic results; a human terminal instead needs raw keyboard input, normal shell configuration and a full screen. Browser rendering and transport can disappear while a command is still running.

## Decision

Guide entries declare stable ids within their provider. A keyed `sidebar.right.tab.guide.entry` slot dispatches by the active provider id, so an extension replacing a builtin also controls its guide rendering. The sidebar owns card placement and the default fallback; provider components own their controls and read the enclosing tab through framework hooks. An entry slot allows a shell menu without replacing the entire guide or nesting an interactive button inside another button.

The application theme supplies terminal default colors. The body reads resolved CSS tokens, and updates xterm only when those colors change. Public OSC parser observers retain indexed and default-color overrides separately from the DSH defaults; resets remove the corresponding override before restoring the current theme. Observers delegate queries and color handling to xterm. xterm's minimum contrast adjustment improves text legibility without remapping ANSI backgrounds. The DOM cursor reads the rendered cell background after each render and uses a contrasting fill through scoped CSS variables, so cursor movement never resets the palette. Browser checks cover indexed, true-color and inverse cells, light/dark switching, OSC retention and reset, and blinking cursor styles.

`api-terminal-controller` owns user terminals by Session and exposes the `terminal` Remote namespace. `ui-sidebar-terminal` registers native right-sidebar tabs, xterm.js rendering and FitAddon sizing. The terminal guide card has a primary action for the remembered available shell and a separate installed-shell menu. Selecting a menu item records its path and opens a new terminal immediately; discovery alone allocates no process. Each tab owns its startup and close lifecycle. Host discovery verifies the configured candidates, with the execution default first; creation accepts only a currently discovered path. The browser remembers the last selected shell path in origin-scoped localStorage and falls back to the current default if that path is unavailable. The terminal type declares independent instances, so ordinary page deduplication cannot collapse separate processes when opening or docking tabs. The existing sidebar controls open additional tabs; double-clicking a tab title renames its terminal. Terminal processes use the composed subprocess provider and Session sandbox policy. Shell resolution occurs during discovery and creation; reading limits and reconnecting an existing process do not depend on the default executable remaining available. Interactive shell configuration supplies Tab completion and optional inline suggestions.

Close and replacement remove the tab synchronously and run process cleanup in the background. The Client first records the unfinished close request under a terminal-specific localStorage key; success removes it, and startup retries requests that remain. A cleanup failure produces a lightweight notification with a retry action without reopening the tab. Independent keys prevent another window from overwriting unrelated cleanup requests. Collapse, tab/Session switching, floating, fullscreen and browser disconnection preserve the process. Component cleanup and `TabDomain.signal` only detach browser work because the same lifetime can end during plugin reload. Failed process cleanup retains ownership, including failures after allocation but before create publication. Session owner disposal and Host plugin disposal also clean up terminals. A definitive missing-Session response retires its saved close request because the Session owns process cleanup; transport failures remain retryable. Client plugin disposal awaits every detached stream so a replacement plugin does not inherit unfinished Client cleanup.

[Sidebar layout persistence and provider recovery](../architecture/2026-09-14-sidebar-layout-provider-recovery.md) owns browser reload: layout and tab identities are restored before the terminal provider reconnects its views. Listing still takes the Session ID directly because history can outlive its Agent and terminal owner; an offline Session has no retained terminals to restore. Only a new view may allocate a process; a recovered target that disappears reports an error. The Host remains authoritative for process state, titles and screen contents.

The caller retains a terminal ID before creating it. Repeating create with the same Session and open ID does not allocate a second process. Closing an uncertain create uses that ID even when no creation response arrived. The Host records closed IDs before awaiting allocation, preventing a delayed create from reviving a closed terminal. Each attachment begins with a consistent, bounded serialized xterm screen; ordered output follows through the Gateway's existing multiplexed Remote stream. Output and screen snapshots share one operation queue. Followers retain final output on normal closure and fail explicitly on buffer overflow. Browser render acknowledgement prevents React batching from dropping increments.

The latest attachment controls input and dimensions; other attachments remain read-only. Every physical stream opening gets a fresh input attachment identity, including automatic transport recovery. Input RPCs are serialized, and results from a superseded attachment cannot downgrade a replacement connection. Terminal output creates no model input, Agent tool result or Session event. The existing [persistent Agent terminal decision](2026-07-16-persistent-pty-sessions.md) continues to govern model-owned sessions; this feature extends the [portable subprocess provider](../architecture/2026-07-28-portable-execution-world-consumers.md) with terminal environment facts and resize. Control-transfer and process-exit refusals only disable input, preserving the healthy output view. Client-owned error identifiers are translated by the terminal UI, including guidance to close retained exited terminals when the quota is full.

## Alternatives considered

**Persist complete shell profiles in the browser.** Only the selected path is a user preference. Arguments and availability belong to Host discovery; persisting them would allow stale profiles to bypass current execution configuration. The sidebar continues to own the terminal list and tab controls.

**Keep the tab visible until process cleanup finishes.** A slow or failed termination would delay the user's close action. Saving the cleanup intent allows immediate removal while preserving failure reporting and retry.

**Persist an authoritative active-process registry.** Browser process state can become stale independently of Host state. The [layout persistence decision](../architecture/2026-09-14-sidebar-layout-provider-recovery.md) supersedes the exclusion of saved tab associations while retaining Host authority for process liveness.

**Share the Agent terminal registry.** Its controlled prompts and semantic send/wait behavior would change human shell configuration and blur process ownership. User terminals share the subprocess capability instead.

**Add a dedicated terminal WebSocket.** The existing Remote stream transport already owns authentication, cancellation and reconnection. A second carrier would duplicate those responsibilities.

**Replay only a bounded raw byte tail.** A tail can begin inside an escape sequence or omit an alternate-screen transition. A serialized terminal screen provides a consistent recovery point with bounded history.

**Kill when a React body or tab signal is disposed.** Unmount, Session switching and plugin reload can end those lifetimes without an explicit close. Cleanup must follow the user's close operation.

**Build a Web completion engine.** Native shell completion already handles commands, paths and configured plugins through ordinary PTY input. An independent completion UI adds shell-specific parsing and synchronization; it is outside this feature.

## Consequences

A kept-open terminal retains a process and bounded screen memory. Reload restores the sidebar layout and reconnects Host-retained terminals; Host restart does not restore processes. An exited shell remains visible without automatic respawn. Background cleanup may outlive its tab, and unavailable browser storage limits retry recovery to the current page. Native PTY support and descendant cleanup guarantees remain provider-specific. One writable attachment avoids competing resize and input streams, while explicit takeover permits recovery from another page. Changing sandbox mode requires closing retained terminals first.

The implementation retains the Agent-terminal and portable-execution notes because their ownership and provider decisions remain independently useful; neither is superseded by browser terminals.

The [two-hour unattended-terminal reclamation](2026-09-14-unattended-browser-terminal-reclamation.md) adds an idle grace period after all frontend holders disconnect, preserving busy or uncertain work.
