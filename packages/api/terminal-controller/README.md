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

The Web bundle mounts this package with the subprocess provider, sandbox policy and Typert Gateway. `remote.terminal` exposes `environment`, `shells`, `list`, `create`, `follow`, `write`, `resize`, `rename` and `close`; each operation is scoped by Session identity. Listing reads retained Host terminals directly, so viewing an offline Session neither activates an Agent nor produces a recovery error.

Shell discovery lists the execution environment's declared default shell first. Only when the provider omits that default does resolution use `/bin/sh` on POSIX or `cmd.exe` on Windows. An optional `shell` profile overrides that choice with executable `path`, display `name` and `args` (default `[]`). The selector also probes `shellCandidates` through the execution provider and omits only confirmed lookup misses. Creation accepts a discovered `shellPath` and verifies it again; resolution or transport failure is reported without launching a different shell. Environment lookup returns the working directory and limits without resolving a shell, so an unavailable default does not prevent reattaching to an existing process. Automatic POSIX profiles start interactively, and PowerShell uses `-NoLogo`, so completion and startup configuration remain shell-owned. The Session workspace supplies the initial directory; its sandbox policy also applies to the terminal.

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

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host uses `ctx.subprocess.spawnTerminal` with `TERM=xterm-256color`; it never launches a desktop terminal application. Streaming UTF-8 decoding preserves split characters and leading BOMs, and replaces incomplete trailing bytes at EOF. Unary control uses the Gateway, and `follow` uses its multiplexed Remote stream transport. Headless xterm and its serializer produce each opening screen after all preceding output writes, then monotone output sequences identify subsequent frames. Slow followers fail explicitly; a new attachment restores the current screen.

The latest attachment owns input and resize. Detachment releases input control without killing the process. Explicit close awaits process cleanup and final output; cleanup failure retains the resource for retry. The Session remembers closed identities and rejects their delayed or repeated creation, including creation already in progress when close arrives. A new terminal uses a new identity. Pending allocations remain owned even if cancellation and cleanup both fail. Session owner disposal and controller disposal also terminate owned processes. An open or pending terminal prevents changing that Session's sandbox mode. Input or resize refused after control transfer or process exit leaves the output attachment intact and disables input; rejected input is not replayed.

Client views keep the association between sidebar tabs and terminal identities in memory. Recovery queries the Host for retained terminals; a new view may create a process, while a recovered view reports a missing target without creating a replacement. The Client model acknowledges screen writes after the browser emulator processes them, serializes input and ignores stale attachment responses. Client-owned errors carry locale keys. Plugin disposal awaits active and previously detached output streams without closing Host processes.

New views wait for explicit shell selection and start. The last selected shell path is stored under `dsh.terminal.shell` in origin-scoped localStorage. A saved path is preselected only while Host discovery still lists it; otherwise the current default is selected. Storage failures do not prevent startup. Restoring existing terminals neither reads this preference nor discovers shells.

Closing saves an unfinished cleanup request before releasing the tab, then awaits Host cleanup in the background. A failure exposes a retry notification. Each request has its own terminal-ID localStorage key and is removed after successful cleanup or a definitive `session/not-found` response; startup retries saved requests. Transport failures retain the request. This stores cleanup intent, not sidebar layout, open-tab mappings, selected tabs or process PIDs. If browser storage is unavailable, cleanup remains usable in memory but cannot be recovered after reload.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Subprocess](../../subprocess/subprocess/README.md)
- [Right Sidebar](../../client/ui-sidebar-right/README.md)
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
- Screen recovery retains bounded history, not a complete transcript. Only one attachment at a time can write or resize.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published. One owner orders terminal metadata and screen updates; the provider exposes no independently observed dimensions to compare.

</details>
