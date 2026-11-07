# Agent Note: Agent terminals in the Web sidebar

Status: implemented

English | [中文](2026-10-12-agent-terminal-panel.zh.md)

## Problem

DSH had two terminal systems that could not see each other. The Agent's [persistent terminals](2026-07-16-persistent-pty-sessions.md) ran in private PTYs that the person could neither watch nor take over, and the [Web sidebar terminals](2026-09-09-web-sidebar-terminal.md) belonged to the person and gave the Agent no access. Comparable products let the Agent run commands in terminals the person can see, and let the Agent read what the person saw. A long-running process the Agent starts, such as a dev server, should be visible where the person works, without new model tools or a second permission model.

## Decision

The experimental [`terminal-panel`](../../../../packages/experimental/terminal-panel/README.md) package registers a `ctx.terminals` backend whose sessions are sidebar terminals opened through the [terminal controller](../../../../packages/api/terminal-controller/README.md). The six `terminal_*` tools keep their names, schemas and results; the [experimental terminal bundle](../../../../packages/experimental/terminal-bundle/README.md) mounts this backend in place of `terminal-bash`.

### Ownership by creator

Terminals are partitioned by who opened them. An Agent terminal records `origin: 'agent'` and starts with `control: 'agent'`; the person's first typed browser input passes control to the person. The browser marks input as typed only shortly after a keyboard, paste, input-method, drop, pointer or touch gesture, because xterm.js reports terminal-protocol replies through the same data event; focus reports and wheel-produced arrow keys never count, so focusing or scrolling an Agent terminal does not take it over. After takeover the controller refuses Agent writes, signals and closing, reads continue, and `terminal_close` releases the registry session without ending the shell. Terminals the person opened are never writable by the Agent; `user_terminal_list` and `user_terminal_read` read them, and `readUserTerminals: false` removes both tools.

### Permissions

An Agent terminal starts under the Session sandbox policy that the bash tool resolves, and the controller wraps confined shells through `ctx.sandbox` exactly as `terminal-bash` does. Commands in the terminal cannot request escalation; the guidance sends denied commands back to bash. Changing the Session's sandbox mode neither blocks the change nor stops open Agent terminals, whose processes keep their launch policy like bash background jobs. Unlike a background job, a terminal keeps accepting commands, so once the Session resolves a different policy `terminal_send` refuses input and points the model to a new terminal; reads, signals and closing continue. User terminals keep the [system-user permissions](../architecture/2026-09-16-user-terminal-permissions.md) of their own decision. Subagents are refused, because their terminals would not appear in the Session the person is viewing.

### Readiness and reads

The backend adds nothing to shell startup, because remote execution environments such as SSH lack the Host's files. A send returns `stdin_read` once output is silent and the shell's process group, or a program the provider reports as reading terminal input, owns the foreground; quiet commands become `inferred_idle` and busy ones `timeout`. Foreground inspection may start `ps` twice on macOS, so it runs only after silence and at a bounded rate. Results render the controller's headless screen from a mark at the start of the send's logical line; background reads move that mark past consumed complete lines.

### Presentation

The controller streams each Session's terminal list. A displayed Session opens a sidebar tab for each running Agent terminal it does not show yet, expanding a collapsed sidebar, and badges terminals the Agent controls, or after takeover a confined sandbox, naming the sandbox mode on hover. A terminal that leaves the list while the Agent controls it closes its tabs.

## Alternatives considered

**Share one terminal between the person and the Agent.** It covers re-running a failed command in place, but interleaved input, changing foreground programs such as ssh or sudo prompts, and running Agent commands in an unconfined terminal holding the person's login state would need approval for every write. Reading the person's terminal and re-running in an Agent terminal covers the same case.

**Add a separate tool family for visible terminals.** The model would see two overlapping terminal tool sets. Ownership by creator matches the registry's rule that a session belongs to the Agent that opened it, so a backend suffices.

**Mirror `terminal-bash` sessions into the sidebar read-only.** Those shells run with controlled prompts, `TERM=dumb` and sanitized line output, so there is no screen for xterm.js and the person could neither type nor be read.

**Inject shell integration for exact command completion.** Prompt markers from injected startup files give exact readiness and exit codes, but the files would have to exist inside every execution environment and sandbox; silence plus foreground inspection works wherever the provider can inspect processes.

**Reuse the Agent's sandbox fence on mode changes.** `terminal-bash` rejects mode changes while terminals are open; visible terminals the person may have taken over would then block permission changes indefinitely, and counting only Agent-controlled terminals would still make the person close the Agent's dev server before tightening permissions. Closing Agent terminals on a stricter mode would end processes the person may be watching.

## Consequences

The Agent's long-running work is visible and interruptible by the person, and the person can point the Agent at their own terminal without copying text. Screen text the Agent reads from the person's terminals enters the Session log and model requests, which the `readUserTerminals` switch controls. Readiness is inferred: a silent shell builtin reads as `stdin_read`, and on macOS a program waiting for input returns only after `idleSilenceMs`. A terminal taken over cannot be handed back, and the backend needs the Web or Desktop composition that mounts the terminal controller.

Controller and sidebar tests cover takeover, typed-input recognition, refusals, screen reads, marks and roster streams; backend tests cover every wait reason, cancellation, release and subagent refusal on a fake clock, and an integration test drives a real shell through the registry. The `terminal-panel-tools` snapshot records the guidance, schemas and user-terminal results.
