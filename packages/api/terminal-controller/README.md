---
description: "Interactive user terminals with execution-environment shell defaults, bounded screen recovery and typed Remote control."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-terminal-controller

English | [中文](README.zh.md)

## Summary

Open the execution environment's default shell in a Session workspace from the Web sidebar. Reconnect to existing processes and close their complete provider-owned process ranges. Terminal output stays outside the Agent transcript. Keeping a terminal open retains its process and a bounded screen buffer.

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

The Web bundle mounts this package with the subprocess provider, sandbox policy and Typert Gateway. Sandbox policy supplies only the fallback working directory for Sessions without a cwd. `remote.terminal` exposes `environment`, `shells`, `list`, `create`, `retain`, `follow`, `write`, `resize`, `rename` and `close`; each operation is scoped by Session identity. Listing reads retained Host terminals directly, so viewing an offline Session neither activates an Agent nor produces a recovery error.

Shell discovery lists the execution environment's declared default shell first. Only when the provider omits that default does resolution use `/bin/sh` on POSIX or `cmd.exe` on Windows. An optional `shell` profile overrides that choice with executable `path`, display `name` and `args` (default `[]`). The selector also probes `shellCandidates` through the execution provider and omits only confirmed lookup misses. Creation accepts a discovered `shellPath` and verifies it again; resolution or transport failure is reported without launching a different shell. Environment lookup returns the working directory and limits without resolving a shell, so an unavailable default does not prevent reattaching to an existing process. Automatic POSIX profiles start interactively, and PowerShell uses `-NoLogo`, so completion and startup configuration remain shell-owned. The Session workspace supplies the initial directory. User terminals run with the execution environment’s system-user permissions, independently of the Agent’s sandbox mode and approval policy. Operating-system and container restrictions still apply; DSH does not elevate the user. The subprocess provider retains its credential-environment scrubbing.

| Configuration | Default | Meaning |
|---|---|---|
| `shell` | omitted | Use the execution environment's default shell, or one explicit profile |
| `shellCandidates` | `zsh`, `bash`, `fish`, `pwsh`, `powershell`, `cmd` | Additional executable names or paths offered when installed |
| `maxTerminals` | `8` | Retained terminals and pending allocations per Session |
| `maxCols`, `maxRows` | `500`, `200` | Maximum PTY dimensions |
| `scrollback` | `1000` | Retained screen history rows |
| `maxBufferedBytes` | `2097152` | Output queued for one follower |
| `maxInputBytes` | `65536` | Maximum input request bytes |
| `disposeGraceMs` | `1000` | Provider termination grace in milliseconds |
| `unattendedTimeoutMs` | `7200000` | Continuous confirmed idle time without window holds before cleanup; `0` disables automatic reclamation |
| `activityPollIntervalMs` | `30000` | Interval between unattended activity observations |
| `cleanupRetryMs` | `60000` | Delay before retrying failed cleanup |

An open tab in any connected window retains its terminal, including hidden tabs and inactive Sessions. After the last hold disappears, only positively confirmed idle time counts toward reclamation. Running, stopped, input-waiting and background work remains protected; unknown activity clears the idle deadline. Completion starts a fresh full grace period. The Host uses a monotonic clock, rechecks current ownership and activity before cleanup, and resets evidence after an observation gap exceeding twice the polling interval. The timing fields use milliseconds and safe integers; polling and retry intervals must be positive.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host uses `ctx.subprocess.spawnTerminal` with `TERM=xterm-256color`; it never launches a desktop terminal application. Streaming UTF-8 decoding preserves split characters and leading BOMs, and replaces incomplete trailing bytes at EOF. Unary control uses the Gateway, and `follow` uses its multiplexed Remote stream transport. Headless xterm and its serializer produce each opening screen after all preceding output writes, then monotone output sequences identify subsequent frames. Slow followers fail explicitly; a new attachment restores the current screen.

The latest attachment owns input and resize. Detachment releases input control without killing the process. Explicit close awaits process cleanup and final output; cleanup failure retains the resource for retry. The Session remembers closed identities and rejects their delayed or repeated creation, including creation already in progress when close arrives. A new terminal uses a new identity. Pending allocations remain owned even if cancellation and cleanup both fail. Session owner disposal and controller disposal also terminate owned processes. Changing the Session’s sandbox mode leaves user terminals running with the same permissions. Input or resize refused after control transfer or process exit leaves the output attachment intact and disables input; rejected input is not replayed.

The Client saves each Session/content-to-terminal association before allocation under its own `dsh.terminal.binding.v1.*` localStorage key. The content identity is globally unique; layout-local tab ids only identify live view occurrences. Independent record writes and deletes preserve other windows' bindings. Restored views reuse that identity; the sidebar terminal provider restores its views before querying unrepresented Host terminals. A new view may create a process, while a recovered view reports a missing target without creating a replacement. Explicit close removes the association after saving its cleanup request. The Host supplies current process metadata and screen contents; neither is saved in the browser. The Client model acknowledges screen writes after the browser emulator processes them, serializes input and ignores stale attachment responses. Client-owned errors carry locale keys. Plugin disposal awaits active and previously detached output streams without closing Host processes.

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

None, as this package handles user terminal interaction without adding model input.

#### KV Cache effect

None; terminal output travels only between the browser and Host.

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

No runtime invariant companion is published. One owner orders terminal metadata and screen updates; the provider exposes no independently observed dimensions to compare.

</details>
