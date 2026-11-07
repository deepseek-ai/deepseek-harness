---
description: "Persistent Agent terminals shown in the Web sidebar, which the person can watch and take over, plus read-only access to the person's own terminals."
kind: "package-reference"
---

# @deepseek-ai/dsh-terminal-panel

English | [中文](README.zh.md)

## Summary

Show an Agent's persistent terminals in the Web sidebar. The package registers a `ctx.terminals` backend whose sessions are sidebar terminals from the [terminal controller](../../api/terminal-controller/README.md), so the six [`terminal_*` tools](../tool-terminal/README.md) keep their names, parameters and results while each `terminal_open` becomes a tab the person can watch and type into. The person's first keystroke takes the terminal over; afterwards the Agent can only read it. Two read-only tools list and read the terminals the person opened. The [experimental terminal bundle](../terminal-bundle/README.md) mounts it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a group that isolates `terminals`, beside the registry and the tools, in a composition that already mounts the terminal controller, as the Web and Desktop compositions do:

```yaml
- name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - name: '@deepseek-ai/dsh-terminal'
    - name: '@deepseek-ai/dsh-terminal-panel'
    - name: '@deepseek-ai/dsh-tool-terminal'
```

### Agent terminals

`terminal_open` resolves the Session's sandbox policy the way the bash tool does and opens a terminal for the calling Agent: confined modes run the shell inside the sandbox, `danger-full-access` runs it directly, and commands in the terminal cannot request more access. The shell keeps that policy; once the Session resolves a different one, for example after the person changes the sandbox mode, `terminal_send` fails and tells the model to open a new terminal, while reads, signals and closing continue. The terminal is titled with the `name` argument or its session id and starts in the requested directory or the Session's working directory. It returns after the shell has printed, stayed silent for `startupSilenceMs` and owns the foreground, with the rendered screen as its startup output; the person's startup files run first.

`terminal_send` writes the text and Enter, then returns `stdin_read` once output has been silent for `promptSilenceMs` and the shell, or a program waiting for terminal input, owns the foreground. A quiet command returns `inferred_idle` after `idleSilenceMs`, a busy one `timeout` after `timeoutMs`, and an exited or closed terminal `session_exit`. Cancelling a send interrupts the command its input started. Results render the screen from the line where the send began, joining wrapped rows; `terminal_read` pages the rendered screen including scrollback.

Once the person types or pastes into an Agent terminal, `terminal_send` and `terminal_signal` fail with an explanation, `terminal_read` keeps working, and `terminal_close` only removes the terminal from the Agent's list, leaving its shell and processes running for the person. Before takeover, `terminal_close` ends the shell and removes the tab. Subagents are refused, because their terminals would not appear in the Session the person is viewing.

### User terminals

`user_terminal_list` lists the terminals the person controls with their start directory and whether a command is running. `user_terminal_read` renders the newest lines of one of them. Neither writes to a terminal. Subagents are refused, because their Sessions hold none of the person's terminals. `readUserTerminals: false` removes both tools.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `backendType` | `shell` | Terminal registry type served by sidebar terminals |
| `cols`, `rows` | `160`, `40` | Initial size; an open sidebar view resizes the terminal to its panel |
| `preferredShells` | `[]` | Executable names tried among the discovered shells before the default shell |
| `environment` | `PAGER`, `GIT_PAGER` = `cat` | Variables added to Agent terminal environments; a configured value replaces the default, so keep `PAGER` and `GIT_PAGER` in it, or programs such as `git log` stop in a pager |
| `startupSilenceMs`, `startupTimeoutMs` | `300`, `15000` | Startup silence and bound |
| `promptSilenceMs` | `300` | Silence before a send checks the foreground |
| `probeIntervalMs` | `1000` | Minimum interval between foreground inspections |
| `idleSilenceMs`, `timeoutMs` | `3000`, `30000` | Silence that ends a send as `inferred_idle`, and the send bound |
| `maxReadBytes` | `262144` | UTF-8 bound on screen reads, send output and startup output |
| `readUserTerminals` | `true` | Register the two user-terminal tools |

Loading fails when `promptSilenceMs` exceeds `idleSilenceMs`, `idleSilenceMs` exceeds `timeoutMs`, or `startupSilenceMs` exceeds `startupTimeoutMs`. The terminal controller's `maxAgentTerminals` and `maxTerminals` bound how many terminals an Agent can open.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin registration and guidance |
| [`src/config.ts`](src/config.ts) | Configuration and timing validation |
| [`src/backend.ts`](src/backend.ts) | Subagent refusal, terminal opening and startup |
| [`src/session.ts`](src/session.ts) | Sends, readiness, output reading, signals and release |
| [`src/tools.ts`](src/tools.ts) | User-terminal tools |

### Readiness

The backend adds nothing to the shell's startup, because execution environments such as SSH do not have the Host's files. Readiness combines output silence with the foreground process group: the shell's own group means it is at its prompt, and on Linux the provider also reports a program reading terminal input. Each inspection may start `ps` twice on macOS, so inspections run only after silence and at most once per `probeIntervalMs`.

### Output

A send drains received output, marks the start of the cursor's logical line and writes its input. Background reads take the complete lines after the mark and move the mark to the line still being written; the result renders the rest. A mark trimmed out of scrollback reports truncated output.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Terminal controller](../../api/terminal-controller/README.md) — Agent terminal allocation, takeover and screen reads.
- [Sidebar terminal](../../client/ui-sidebar-terminal/README.md) — how Agent terminals appear and how typed input is recognized.
- [Terminal tools](../tool-terminal/README.md) — the six tools this backend serves.
- [Terminal service](../../terminal/terminal/README.md) — the registry contract and ownership rules.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The plugin contributes this fixed section after the terminal tools' guidance:

##### Visible terminal guidance

```markdown
Terminals you open with terminal_open appear in the user's side panel. The user can watch them and type into them; once the user types into one, you can only read it, and terminal_close then only removes it from your terminal list while its shell and processes keep running for the user. Use visible terminals for long-running processes the user should see, such as dev servers and watchers; keep using bash for short commands whose output you need now. Commands in these terminals run in the session sandbox and cannot request more access; when one is denied permission, run it with bash instead. Never type passwords or one-time codes; ask the user to enter them in the terminal.
```

#### Token effect

Small fixed input cost on every request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin stays loaded; loading or unloading it changes the system prompt of live Sessions once.

### Tool schemas

#### What the model sees

The two schemas are listed in the [`dsh-terminal-panel` catalog section](../../../docs/tool-catalog.md#deepseek-aidsh-terminal-panel). The six terminal tools keep the schemas of [`dsh-tool-terminal`](../../../docs/tool-catalog.md#deepseek-aidsh-tool-terminal).

#### Token effect

Fixed schema cost while `readUserTerminals` is on.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results

#### What the model sees

`user_terminal_list` returns one line per terminal: id, title, start directory and `command running: yes | no | unknown`. `user_terminal_read` returns rendered screen text followed by `[lines: <begin>-<end> of <total>]` and, when cut, `[output truncated]`. Terminal tool results carry the rendered screen of Agent terminals. Screen text of the person's terminals enters the Session log and model requests.

#### Token effect

Data-dependent and bounded by `maxReadBytes`; results stay in history until compaction.

#### KV Cache effect

Append-only; new results follow the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No hand-back after takeover** — once the person types into an Agent terminal, the Agent cannot regain input; it opens a new terminal instead.
- **No escalation inside terminals** — sandboxed commands that need more access must be rerun with bash, which can request approval.
- **Inferred readiness** — a silent shell builtin, such as `wait`, reads as `stdin_read`; on macOS a program waiting for input returns only after `idleSilenceMs`; a nested shell at its prompt returns `inferred_idle`.
- **Point-in-time user reads** — `user_terminal_read` returns the current screen and does not wait for new output.
- **Sandboxed startup files** — confined shells cannot write files outside the writable roots, so startup files that do may print errors into the terminal.
- **Shared history under full access** — a `danger-full-access` terminal keeps the inherited `HISTFILE`, usually the person's own history file, so the Agent's commands join that history and the Agent's shell loads it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
