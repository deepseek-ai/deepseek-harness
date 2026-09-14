# Agent Note: Web sidebar terminals

Status: implemented

English | [中文](2026-09-09-web-sidebar-terminal.zh.md)

## Problem

Web users need an interactive shell beside a Session to inspect the workspace and run commands. The Agent's persistent terminal tools control prompts and wait for semantic results; a human terminal instead needs raw keyboard input, normal shell configuration and a full screen. Browser rendering and transport can disappear while a command is still running.

## Decision

The application theme owns terminal background, default text, cursor and selection colors. The terminal body reads the rendered DSH palette after framework-delivered theme changes, so CSS token overrides remain effective. Updating the existing xterm instance preserves its output and PTY attachment; shell-provided ANSI colors remain independent.

`api-terminal-controller` owns user terminals by Session and exposes the `terminal` Remote namespace. `ui-sidebar-terminal` registers native right-sidebar tabs, xterm.js rendering and FitAddon sizing. A new terminal offers installed shells and waits for Start. Host discovery verifies the configured candidates, with the execution default first; creation accepts only a currently discovered path. The browser remembers the last selected shell path in origin-scoped localStorage and falls back to the current default if that path is unavailable. The terminal type declares independent instances, so ordinary page deduplication cannot collapse separate processes when opening or docking tabs. The existing sidebar controls open additional tabs; double-clicking a tab title renames its terminal. Terminal processes use the composed subprocess provider and Session sandbox policy. Shell resolution occurs during discovery and creation; reading limits and reconnecting an existing process do not depend on the default executable remaining available. Interactive shell configuration supplies Tab completion and optional inline suggestions.

Close and replacement remove the tab synchronously and run process cleanup in the background. The Client first records the unfinished close request under a terminal-specific localStorage key; success removes it, and startup retries requests that remain. A cleanup failure produces a lightweight notification with a retry action without reopening the tab. Independent keys prevent another window from overwriting unrelated cleanup requests. Collapse, tab/Session switching, floating, fullscreen and browser disconnection preserve the process. Component cleanup and `TabDomain.signal` only detach browser work because the same lifetime can end during plugin reload. Failed process cleanup retains ownership, including failures after allocation but before create publication. Session owner disposal and Host plugin disposal also clean up terminals. A definitive missing-Session response retires its saved close request because the Session owns process cleanup; transport failures remain retryable. Client plugin disposal awaits every detached stream so a replacement plugin does not inherit unfinished Client cleanup.

Sidebar layout, open-tab mappings, selection and process PIDs are not persisted. When the Session header mounts, the Client queries `terminal.list` and opens retained Host terminals as new tabs. Listing takes the Session ID directly because history can outlive its Agent and terminal owner; an offline Session has no retained terminals to restore. Their `params.terminalId` association exists only in the current page. New and recovered views use different `createWhenMissing` values: only a new view may allocate a process; a recovered target that disappears reports an error. Host state supplies recovery identities and titles, so the browser does not maintain a second active-terminal registry.

The caller retains a terminal ID in memory before creating it. Repeating create with the same Session and open ID does not allocate a second process. Closing an uncertain create uses that ID even when no creation response arrived. The Host records closed IDs before awaiting allocation, preventing a delayed create from reviving a closed terminal. Each attachment begins with a consistent, bounded serialized xterm screen; ordered output follows through the Gateway's existing multiplexed Remote stream. Output and screen snapshots share one operation queue. Followers retain final output on normal closure and fail explicitly on buffer overflow. Browser render acknowledgement prevents React batching from dropping increments.

The latest attachment controls input and dimensions; other attachments remain read-only. Every physical stream opening gets a fresh input attachment identity, including automatic transport recovery. Input RPCs are serialized, and results from a superseded attachment cannot downgrade a replacement connection. Terminal output creates no model input, Agent tool result or Session event. The existing [persistent Agent terminal decision](2026-07-16-persistent-pty-sessions.md) continues to govern model-owned sessions; this feature extends the [portable subprocess provider](../architecture/2026-07-28-portable-execution-world-consumers.md) with terminal environment facts and resize. Control-transfer and process-exit refusals only disable input, preserving the healthy output view. Client-owned error identifiers are translated by the terminal UI, including guidance to close retained exited terminals when the quota is full.

## Alternatives considered

**Persist complete shell profiles in the browser.** Only the selected path is a user preference. Arguments and availability belong to Host discovery; persisting them would allow stale profiles to bypass current execution configuration. The sidebar continues to own the terminal list and tab controls.

**Keep the tab visible until process cleanup finishes.** A slow or failed termination would delay the user's close action. Saving the cleanup intent allows immediate removal while preserving failure reporting and retry.

**Persist sidebar layout or an active tab-to-process registry.** Layout persistence is outside this feature. An additional active registry duplicates Host state and can restore stale associations. Only an unfinished close is an independent user request that must survive page reload.

**Share the Agent terminal registry.** Its controlled prompts and semantic send/wait behavior would change human shell configuration and blur process ownership. User terminals share the subprocess capability instead.

**Add a dedicated terminal WebSocket.** The existing Remote stream transport already owns authentication, cancellation and reconnection. A second carrier would duplicate those responsibilities.

**Replay only a bounded raw byte tail.** A tail can begin inside an escape sequence or omit an alternate-screen transition. A serialized terminal screen provides a consistent recovery point with bounded history.

**Kill when a React body or tab signal is disposed.** Unmount, Session switching and plugin reload can end those lifetimes without an explicit close. Cleanup must follow the user's close operation.

**Build a Web completion engine.** Native shell completion already handles commands, paths and configured plugins through ordinary PTY input. An independent completion UI adds shell-specific parsing and synchronization; it is outside this feature.

## Consequences

A kept-open terminal retains a process and bounded screen memory. Reload restores Host-retained terminals rather than the previous sidebar layout; Host restart does not restore processes. An exited shell remains visible without automatic respawn. Background cleanup may outlive its tab, and unavailable browser storage limits retry recovery to the current page. Native PTY support and descendant cleanup guarantees remain provider-specific. One writable attachment avoids competing resize and input streams, while explicit takeover permits recovery from another page. Changing sandbox mode requires closing retained terminals first.

The implementation retains the Agent-terminal and portable-execution notes because their ownership and provider decisions remain independently useful; neither is superseded by browser terminals.
