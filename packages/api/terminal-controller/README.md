---
description: "Interactive user terminals with execution-environment shell defaults, bounded screen recovery and typed Remote control."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-terminal-controller

English | [中文](README.zh.md)

## Summary

Open the execution environment's default shell in the Session's current working directory from the Web sidebar. Reconnect to existing processes and close their complete provider-owned process ranges. Agent tools can also open terminals here: they appear as sidebar tabs, start under the Session sandbox policy and pass to the person on the person's first typed input. The controller adds no model input; a tool package decides what an Agent reads. Keeping a terminal open retains its process and a bounded screen buffer.

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

The Web bundle mounts this package with the subprocess provider, working-directory service, sandbox policy and Typert Gateway. `remote.terminal` exposes `environment`, `shells`, `list`, `watch`, `create`, `retain`, `attach`, `rename` and `close`; each operation is scoped by Session identity. Listing reads retained Host terminals directly, so viewing an offline Session neither activates an Agent nor produces a recovery error. `watch` streams the same list as whole sets after creation, removal and every published state change.

Shell discovery lists the execution environment's declared default shell first. Only when the provider omits that default does resolution use `/bin/sh` on POSIX or `cmd.exe` on Windows. An optional `shell` profile overrides that choice with executable `path`, display `name` and `args` (default `[]`). The selector also probes `shellCandidates` through the execution provider and omits confirmed lookup misses. It lists each executable name once, ignoring letter case and `.exe`, and keeps the earliest entry, because PATH lookup can reach the default through another directory, such as `/usr/bin/bash` for `/bin/bash` on merged-`/usr` systems. Creation accepts a discovered `shellPath` and verifies it again; resolution or transport failure is reported without launching a different shell. Environment lookup reads the current directory and limits without filesystem validation or shell resolution, so unavailable directories or default shells do not prevent reattaching to an existing process. Automatic POSIX profiles start interactively, and PowerShell uses `-NoLogo`, so completion and startup configuration remain shell-owned. New terminals validate the current directory through the [working-directory service](../../session/working-directory/README.md) before spawning, including its recovery behavior. Existing terminals keep their process directories. User terminals run with the execution environment’s system-user permissions, independently of the Agent’s sandbox mode and approval policy. Operating-system and container restrictions still apply; DSH does not elevate the user. The subprocess provider retains its credential-environment scrubbing.

| Configuration | Default | Meaning |
|---|---|---|
| `shell` | omitted | Use the execution environment's default shell, or one explicit profile |
| `shellCandidates` | `zsh`, `bash`, `fish`, `pwsh`, `powershell`, `cmd` | Additional executable names or paths offered when installed |
| `maxTerminals` | `8` | Retained terminals and pending allocations per Session |
| `maxAgentTerminals` | `4` | Running Agent-controlled terminals and pending Agent allocations per Session; `maxTerminals` still bounds every terminal, including exited ones and failed allocations awaiting cleanup |
| `maxCols`, `maxRows` | `500`, `200` | Maximum PTY dimensions |
| `scrollback` | `1000` | Retained screen history rows |
| `maxBufferedBytes` | `2097152` | Encoded output per follower and buffered Client input |
| `maxInputBytes` | `65536` | Maximum raw UTF-8 bytes per input command and across unacknowledged Client input |
| `disposeGraceMs` | `1000` | Provider termination grace in milliseconds |
| `unattendedTimeoutMs` | `7200000` | Continuous confirmed idle time without window holds before cleanup; `0` disables automatic reclamation |
| `activityPollIntervalMs` | `30000` | Interval between unattended activity observations |
| `cleanupRetryMs` | `60000` | Delay before retrying failed cleanup |

An open tab in any connected window retains its terminal, including hidden tabs and inactive Sessions. After the last hold disappears, only positively confirmed idle time counts toward reclamation. Running, stopped, input-waiting and background work remains protected; unknown activity clears the idle deadline. Completion starts a fresh full grace period. The Host uses a monotonic clock, rechecks current ownership and activity before cleanup, and resets evidence after an observation gap exceeding twice the polling interval. The timing fields use milliseconds and safe integers; polling and retry intervals must be positive.

### Agent terminals

Host code opens a terminal for a Session's Agent with `openForAgent(agent, request, signal)`. The caller supplies the sandbox policy it resolved for the Session: `danger-full-access` launches the shell directly, confined modes wrap it through the execution environment's `ctx.sandbox` provider, and a missing provider fails before allocation. Confined POSIX shells never load or write the person's history file, which is outside the writable roots: a `workspace-write` shell keeps its history in `/tmp/dsh-agent-history-<id>`, which the controller deletes after the shell ends, and a `read-only` shell gets an empty `HISTFILE` and keeps none. `preferredShells` names executables tried among discovered shells before the default, and `env` adds variables to the shell environment; it cannot replace `DSH_SESSION_ID`, nor `HISTFILE` in confined POSIX shells, while unconfined shells keep the inherited `HISTFILE` unless `env` sets one. The terminal records `origin: 'agent'`, `control: 'agent'` and its `sandboxMode`; it counts toward `maxTerminals` and, while the Agent controls it and it runs, toward `maxAgentTerminals`. Its title must contain 1–120 characters after surrounding whitespace is removed.

The returned `AgentTerminal` reports the top-level process id, writes input, renders the screen as text, marks a screen position to render later output, waits for output or state changes, inspects and signals the foreground process group, and closes the terminal. Its screen reads and marks are synchronous and see output applied so far; `drain` waits until output received before the call is applied. Agent input neither needs nor takes Web input control. The first browser write marked `typed` passes control to the person; afterwards writes, signals and closing fail with `AgentTerminalError` code `user-control`, while reads continue. The controller's `readScreen` drains before rendering, and it and `inspectActivity` read any terminal of the Agent's Session, including terminals the person opened. `readScreen` fails with `RemoteError` code `terminal/unavailable` when the terminal is missing or closes before its screen is read.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host uses `ctx.subprocess.spawnTerminal` with `TERM=xterm-256color`; it never launches a desktop terminal application. Streaming UTF-8 decoding preserves split characters and leading BOMs, and replaces incomplete trailing bytes at EOF. The duplex `attach` Remote stream carries output and ordered `write`/`resize` commands on the Gateway mux. Each command has a consecutive attachment-local sequence; an `ack` confirms provider acceptance or reports control refusal. Snapshots and state frames carry the receiving attachment's `writable` flag. Headless xterm and its serializer produce each opening screen after all preceding output writes, then monotone output sequences identify subsequent frames. Slow followers fail explicitly; a new attachment restores the current screen.

Agent terminals reuse the same allocation, rollback and retention paths with a Host-minted identity. Agent input is queued with browser input and output but bypasses attachment control. Screen reads render the headless buffer: wrapped rows are joined, the alternate screen is read as displayed, and pages keep the newest bytes within the caller's bound. Screen marks place emulator markers at the start of the cursor's logical line, so trimmed scrollback reports truncation. A change revision advances after each applied output chunk and state publication, and `changed` waits on it. The Client marks a write `typed` only within a short window after keyboard, paste, IME, drop, pointer or touch input, because xterm.js reports terminal-protocol replies through the same data event; focus reports and wheel-produced input are never `typed`.

The latest attachment owns input and resize. Detachment releases input control without killing the process. Explicit close awaits process cleanup and final output; cleanup failure retains the resource for retry. The Session remembers closed identities and rejects their delayed or repeated creation, including creation already in progress when close arrives. A new terminal uses a new identity. Pending allocations remain owned even if cancellation and cleanup both fail. Session owner disposal and controller disposal also terminate owned processes. Changing the Session’s sandbox mode leaves user terminals running with the same permissions. Input or resize refused after control transfer or process exit leaves the output attachment intact and disables input; rejected input is not replayed. Provider completion disables input before output drainage finishes, and late input failures cannot discard a gracefully finished follower's final frames.

The opening snapshot advertises the carrier's complete-frame `inputWindow`; in-process carriers without an inbox limit omit it. The Client counts JSON escaping, command fields, and the carrier envelope for both writes and resizes. Commands wait locally while unacknowledged frames fill that window; provider acknowledgements release capacity. `maxInputBytes` bounds raw UTF-8 input, while `maxBufferedBytes` bounds all queued and unacknowledged encoded input frames. A single frame that cannot fit the carrier window, or an exhausted Client buffer, reports `inputFull` and cancels the attachment without replaying queued commands.

The Client saves each Session/content-to-terminal association before allocation under its own `dsh.terminal.binding.v1.*` localStorage key. The content identity is globally unique; layout-local tab ids only identify live view occurrences. Independent record writes and deletes preserve other windows' bindings. Restored views reuse that identity; the sidebar terminal provider restores its views before querying unrepresented Host terminals. A new view may create a process, while a recovered view reports a missing target without creating a replacement. Explicit close removes the association after saving its cleanup request. The Host supplies current process metadata and screen contents; neither is saved in the browser. The Client model acknowledges screen writes after the browser emulator processes them, pipelines input within its unacknowledged UTF-8 byte budget and ignores stale attachment responses. Reconnection creates a fresh command sequence and never replays unacknowledged input. Provider input failures end the attachment; its process and recovery screen remain available for explicit reconnection. Client-owned errors carry locale keys. Plugin disposal awaits active and previously detached output streams without closing Host processes.

Client discovery belongs to each Session in the current window. Concurrent and later restored views share one list, including an empty result; new identities allocate directly from `create`. Explicit retry replaces a settled result or failure, and reconnection refreshes each previously discovered Session once. Remounting a failed view preserves its error without retrying. Confirmed mutations and attachment metadata take precedence over an older pending list response, and responses from replaced connections cannot publish. A view releasing its DOM or lifetime does not cancel another view’s lookup. Plugin disposal discards cached metadata and joins outstanding discovery. Other windows’ unrepresented terminals become discoverable through explicit refresh or reconnection; current attachments carry their own live metadata. `watch(sessionId, listener)` shares one roster stream per Session in a window and applies each whole roster to the shared list, dropping terminals it no longer lists, before listeners run; `boundTerminal` reads the terminal a tab is bound to; a stream that fails while watched reopens for its remaining listeners on the next watch of that Session or after the connection resets; `bind` saves a tab's association with an existing terminal before its body mounts. Environment lookup remains separate because its working directory can change.

The separate `retain(sessionId, id, signal)` Remote stream acknowledges a window hold without Agent activation, screen output, input transfer or process creation. The terminal provider supplies the sidebar's complete open-tab inventory, and the Client intersects it with its own saved identities. Duplicate occurrences share one hold per window; stale associations alone retain nothing. Restored output attachments wait for an acknowledged current hold. Transport cancellation releases exactly that physical generation; plugin disposal joins all hold streams. Failed cleanup retains ownership and retries without reopening admission or restarting the idle grace.

New views start automatically, using an explicit guide selection or the remembered available shell. The last selected shell path is stored under `dsh.terminal.shell` in origin-scoped localStorage. Default launches verify the saved path through Host discovery and fall back to the current default when it is absent. The guide records a selection before opening its tab; each new tab retains its own chosen path and allocation identity. Storage failures do not prevent startup. Restoring existing terminals neither reads this preference nor discovers shells.

Closing saves an unfinished cleanup request before releasing the tab, then awaits Host cleanup in the background. A failure exposes a retry notification. Each request has its own terminal-ID localStorage key and is removed after successful cleanup or a definitive `session/not-found` response; startup retries saved requests. Transport failures retain the request. Cleanup requests persist independently of tab associations and sidebar layout. If browser storage is unavailable, cleanup remains usable in memory but cannot be recovered after reload.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Subprocess](../../subprocess/subprocess/README.md)
- [Right Sidebar](../../client/ui-sidebar-right/README.md)
- [User-terminal permissions](../../../.agents/notes/implemented/architecture/2026-09-16-user-terminal-permissions.md)
- [Web terminal decision](../../../.agents/notes/implemented/feature/2026-09-09-web-sidebar-terminal.md)

<a id="model-experience"></a>
## Model Experience

Indirectly, through [working-directory recovery](../../session/working-directory/README.md): creating a terminal may update directory user context, and terminal text reaches model history only through a consumer of the Agent terminal API.

#### KV Cache effect

Directory recovery appends user context without replacing the system-prompt prefix; the controller adds nothing else to model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Processes and screens survive browser reloads, but not Host or Session owner disposal. There is no durable terminal restoration or automatic shell respawn. Exited terminals count toward `maxTerminals`; close unused tabs to release their screens and quota.
- The subprocess provider determines native PTY availability and process-tree cleanup guarantees. Finding an executable does not prove PTY allocation will succeed.
- Automatic reclamation depends on the provider's [supported shell activity observation](../../subprocess/subprocess-local/README.md#running-terminal-sessions). Unsupported shells, custom launch arguments and uncertain process observations may retain resources until explicit close or owner disposal. No maximum runtime kills busy commands.
- Screen recovery retains bounded history, not a complete transcript. Only one attachment at a time can write or resize.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
