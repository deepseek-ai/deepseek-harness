---
description: "The local host provider for the subprocess service: run OS-owned managed ranges and real terminal sessions on the host machine, with explicit weaker fallbacks."
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess-local

English | [中文](README.zh.md)

## Summary

Mount `dsh-subprocess-local` in any composition that runs child processes on the host. It resolves local executables, gives ordinary Linux and Windows commands plus supported Linux terminal sessions an OS-owned managed range, and provides real terminal sessions through `node-pty`; unsupported hosts use an explicit weaker fallback. It has no configuration, so every disposition, limit, terminal size, and grace arrives on the spawn request from the calling capability seam. Output collection keeps a bounded in-memory tail with optional spill files for full-stream recovery, children start from a scrubbed environment, and disposal terminates and joins every selected range or session.

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

Mount the provider beside its consumers and start processes exactly as the subprocess service specifies; this package decides only how those processes run on the host. On Windows, non-terminal children and `taskkill` helpers start with their windows hidden so background operations do not take focus. This also hides GUI windows that honor the process startup visibility setting.

### Mounting the provider

Load the provider in the same composition as its consumers. It has no config fields: every choice arrives on the spawn request, so deployment-varying decisions stay with the caller's configuration.

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-bash-local'
```

### Resolving executables

Absolute executable paths are verified; bare names resolve against the scrubbed PATH with platform-aware executable extensions (`.COM`/`.EXE`/`.BAT`/`.CMD` on Windows). Relative paths containing separators are rejected — provide an absolute path or a bare PATH name — and relative PATH entries resolve from the host process cwd.

### Collecting output

Collect mode keeps the last `maxBytes` of a stream in memory — errors and final results cluster at the end — and, when a `spill` cap is configured, appends the complete stream to a private file under a per-process directory in the OS temp dir (a `0700` directory, `0600` random-named files). A stream larger than the spill cap discards its incomplete spill and returns only the marked truncated tail. Reads are offset-based and non-consuming, so background and batch readers coexist before and after exit.

### Running terminal sessions

`spawnTerminal` allocates a real PTY and bridges UTF-8 text; you can inspect and signal the current foreground process group and await one `terminate()` operation. On supported Linux hosts, the original terminal argv runs directly inside a user-systemd scope, preserving the node-pty PID, session leader, controlling terminal, foreground `inputWaiting`, and readiness while the scope owns reparented or `setsid` descendants. On fallback hosts, cleanup retains exact identities from the rooted tree and observable session but cannot recover every escaped descendant. An exact Linux input wait requires a foreground thread whose fd 0 identifies the shell's controlling terminal and whose current syscall waits on that fd; if the kernel denies the syscall probe, the higher PTY backend uses its idle inference instead. On Windows, SIGINT is delivered as a Ctrl-C input write, SIGTSTP and SIGHUP are unsupported, and teardown verifies the shell's termination through the process table because an externally killed shell may never fire the PTY exit notification.

### Shutdown behavior

Normal disposal terminates every running managed range and terminal session and awaits quiescence. During a JavaScript-observable host exit — direct `process.exit()`, default uncaught exceptions, default unhandled rejections — synchronous finalization asks a Linux scope to kill its members, kills each Windows runner so its sole Job handle closes, and uses the existing PGID, `taskkill`, or captured-identity operation for fallbacks. It creates no promises or timers and does not claim quiescence. The same exit removes the private per-process spill directory when it holds no completed spill file; completed spill files remain as full-output recovery artifacts until an external cleanup. Unhandled `SIGTERM`/`SIGINT`/`SIGHUP`, `SIGKILL`, fatal OOM, native crashes, and power loss need an external supervisor.

### What can go wrong

An executable that cannot be resolved fails loud with a stable error. `done` rejects when spawn or provider failure prevents a direct outcome, and that rejection does not prove whether target execution began. `waitForExit()` rejects if the selected owner can no longer prove its range empty, and cleanup still attempts termination. A read past the retained tail is `lossy` and points at the spill file when one exists. A fallback process group or observed terminal session can miss a descendant that escapes before observation — see the limitations below.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider and points at the code that realizes them; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Each spawn selects one owner for both signalling and quiescence. Supported Linux ordinary and terminal launches use transient user-systemd scopes, while supported Windows ordinary launches use a helper-owned kill-on-close Job. macOS, older or unavailable user-systemd, and unavailable Windows native support use the existing detached process-group, `taskkill`, or terminal-session observations with one warning. The provider never replays a command through fallback after a native path may have started it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service wiring: live-handle sets, disposal, host-exit finalization, executable lookup |
| [`src/spawn.ts`](src/spawn.ts) | Shared process plumbing: direct outcomes, tail-keep collection, spill files, and fallback spawning |
| [`src/managed-owner.ts`](src/managed-owner.ts) | Private signal-and-wait owner used by each ordinary handle |
| [`src/linux-scope.ts`](src/linux-scope.ts) | Linux user-systemd capability checks, scope launch, signalling, and quiescence |
| [`src/linux-execve.ts`](src/linux-execve.ts) | Linux libc image replacement and inherited-standard-descriptor preservation |
| [`src/windows-job.ts`](src/windows-job.ts) | Windows Job capability checks and helper launch |
| [`src/runner-launch.ts`](src/runner-launch.ts) | Source, built, and packaged private-runner selection |
| [`src/spawn-runner.ts`](src/spawn-runner.ts) | Linux one-shot exec bootstrap and Windows Job runner |
| [`src/runner-protocol.ts`](src/runner-protocol.ts) | Strict Linux launch/startup files and Windows IPC messages |
| [`src/terminal.ts`](src/terminal.ts) | `node-pty` handle: Linux scope attachment, foreground inspection, and fallback cleanup |
| [`src/process-inspector.ts`](src/process-inspector.ts) | POSIX process-tree and session inspection |
| [`src/windows-inspector.ts`](src/windows-inspector.ts) | Windows Toolhelp32 process-table inspection via koffi |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Main flow

A spawn synchronously validates the final argv, cwd, and environment, selects containment before the user command can run, and returns a handle while target identity remains private. Linux ordinary and terminal launches use a private one-shot request whose scoped bootstrap restores the target cwd and environment, resolves the executable, clears close-on-exec on fd 0 through fd 2, and enters libc `execve()` with the original argv. Windows ordinary launches isolate runner fd 0 through fd 2, reserve fd 3 for IPC, and carry target stdio on fd 4 through fd 6; the runner resolves those CRT descriptors to OS handles, creates the target suspended, assigns it to the Job, resumes it, and closes only the carrier descriptors. `done` settles the direct command after its stdio barrier, while `waitForExit()` separately waits for the selected scope, Job, process group, or observed session to become empty.

### Safety invariants

Spill files are opened `0600` with `O_EXCL` and random names under a `0700` per-process directory, defeating symlink planting in shared temp dirs; a failed final close withholds the spill path. Fallback process identities carry start times, so cleanup never follows PID reuse. A selected native failure is reported instead of replaying argv through fallback, and a range is removed from the live set only after cleanup completes or the failure remains observable. Host-exit finalization creates no promises or timers, preserves the host exit code and diagnostic, contains each target's failure, and does not claim quiescence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the provider-level contract is not enough. They move from the exhaustive type reference to the abstract contract and the decisions behind the host mechanics.

- [Subprocess subsystem](../../../docs/subsystems/subprocess.md) — spawn specs, output readers, outcomes, and the `DSH_*` environment in full.
- [dsh-subprocess](../subprocess/README.md) — the abstract contract this provider implements.
- [dsh-bash-local](../../shell/bash-local/README.md) — the largest consumer and the concrete stdio shapes it asks for.
- [Subprocess seam Agent Note](../../../.agents/notes/archived/architecture/2026-07-26-subprocess-seam.md) — why the process half became its own seam.
- [Synchronous subprocess exit cleanup](../../../.agents/notes/archived/bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.md) — the host-exit finalization decision and its failure modes.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through consumer seams such as the bash executor family, which own all model-facing rendering of spawned process output and lifecycle.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a general platform comparison or a task backlog.

- **Native ownership has explicit host requirements** — Linux needs a readable user manager and `systemd-run --expand-environment=no`; older systemd versions use the warned PGID fallback. macOS always uses that fallback because no supported public persistent owner exists.
- **Native selection has bounded per-spawn costs** — Linux repeats the bootstrap entry, libc `execve`/`fcntl` bindings, live user manager, and literal-argv scope probe until it first succeeds; later eligible ordinary or terminal spawns recheck only the live user manager. Windows rechecks the runner entry, bindings, and current Job support before every ordinary spawn. Successful Linux deep-probe state and fallback-warning de-duplication persist for the provider lifetime. All probes finish before the user command can run, and child-process probes have a 5-second timeout. Each Linux launch creates a private request directory, checks unresolved scope establishment every 50 milliseconds, then exponentially backs off an established active scope to at most 5 seconds between queries; a Windows ordinary launch keeps one runner and IPC channel until the Job reports zero active processes. Target standard handles are inherited directly, with no named-pipe stdio or result files.
- **Windows Job inheritance has defined exclusions** — ordinary descendants inherit the Job by default, but breakaway processes are outside the guarantee. The target starts only after Job assignment; external termination of the runner in the narrow create-to-assignment interval can leave a suspended target behind.
- **Windows terminal signalling is console-wide** — SIGINT is delivered as a `\x03` Ctrl-C input write that conhost turns into a console-wide CTRL_C event; SIGTSTP and SIGHUP are rejected as unavailable; a `taskkill` without `/F` does not terminate console processes, so the teardown TERM tier is a grace wait before the `/F` escalation. Windows readiness has no exact stdin-wait tier: the prompt-marker fast path compares the shell pid as the pseudo foreground group, and silence/timing tiers cover the rest.
- **Fallback terminal ownership remains observational** — on macOS or Linux without usable user-systemd, a child that reparents before any foreground-inspection snapshot or leaves the owned terminal session can escape the process-table scan. The local provider does not add a continuous process-table monitor; supported Linux native mode instead retains these descendants through scope membership.
- **In-process cleanup requires a JavaScript-observable exit** — direct `process.exit()`, default uncaught exceptions, and default unhandled rejections emit Node's synchronous `exit` event. The default OS disposition for an unhandled `SIGTERM`, `SIGINT`, or `SIGHUP` bypasses that event; an application covers those signals only by installing a handler that performs normal disposal or calls `process.exit()`. `SIGKILL`, fatal OOM, `process.abort()`, native crashes, power loss, and any failure that cannot run JavaScript require an external supervisor, container init, or equivalent OS owner.
- **The credential scrub is a name heuristic** — `*KEY*`/`*PASSWORD*`/`*SECRET*`/`*TOKEN*` only; differently named secrets (for example `*PASSPHRASE*`) pass through, and a whitelist for over-scrubbed variables is noted future work.
- **Completed spill files are not deleted** — bounded full-output recovery files accumulate under the OS tmpdir until something external cleans them; the private per-process spill directory is removed at a JavaScript-observable exit only when it holds no completed spill file.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
