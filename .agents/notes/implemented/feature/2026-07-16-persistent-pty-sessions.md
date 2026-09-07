# Agent Note: persistent PTY sessions

Status: implemented

English | [中文](2026-07-16-persistent-pty-sessions.zh.md)

## Problem

The harness can run foreground and background commands, edit files, and delegate work, but it cannot continue an interactive terminal conversation across tool calls. Each `bash` foreground run starts a fresh shell, so shell-local cwd, exported variables, virtual-environment activation, functions, job-control state, and interactive child processes end with that call.

That gap excludes workflows whose state lives in a terminal rather than a file: stepping through `gdb`, exploring in a Python or Node REPL, driving a line-oriented editor such as `ed`, or returning to a shell after interrupting its foreground command. The generic [`ctx.jobs`](../../../../packages/jobs/README.md) runtime retains background-operation handles and output, but it does not provide interactive stdin or terminal semantics.

The existing `bash`, `read`, `write`, and `edit` tools remain the reliable default for bounded, auditable operations. A PTY is an additional capability for work that genuinely requires terminal state, not evidence that those tools are defective or candidates for removal.

## Decision

The optional `packages/terminal/` capability family exposes agent-owned, persistent, line-oriented PTY sessions. It follows the repository's [capability pattern](../../implemented/architecture/2026-06-13-capability-seams.md), coexists with the existing command and filesystem tools, and does not change `agent-loop`.

The implementation supports interactive shells and line-oriented REPLs on Linux and macOS. Full-screen terminal applications, keystroke sequences, BEL-triggered control flow, session restoration after process loss, and cross-agent session sharing are explicitly deferred.

### Package topology

| Package | Role | ctx key |
|---|---|---|
| `dsh-terminal` | `TerminalSessionService`, branded `TerminalSessionId`, backend registry, owner-scoped session contract, and result types | `ctx.terminals` |
| `dsh-terminal-bash` | Persistent-shell backend over `ctx.subprocess.spawnTerminal()`: readiness, bounded terminal buffers, sandbox resolution, and owner-aware session lifecycle | registers a backend on `ctx.terminals` |
| `dsh-tool-terminal` | Six model-facing tools, task-runtime integration for background sends, guidance, and UI render intents | registers on `ctx.tools` |

Readiness remains PTY-backend behavior, not a second public contract. The terminal-process provider supplies only substrate facts such as the foreground process group and whether it can prove that group is waiting on input; `dsh-terminal-bash` combines those facts with prompt and silence evidence into the common send result.

### Agent ownership and identity

`TerminalSessionService` stores live sessions process-locally, but every session is owned by the exact `Agent` passed through the tool execution context. The service mints an opaque `TerminalSessionId`; an optional model-chosen `name` is display metadata and is unique only within that owner. Every operation targets `sessionId`, and `list`/`read`/`signal`/`kill` reject callers other than the owner.

There are no plugin-load auto-start sessions. `terminal_open` creates a session only during an agent tool call, when ownership and the owning event-sourced session are known. A future declarative startup feature must compose through unpublished agent setup rather than create shared global terminals.

Agent-scope disposal closes registrations first, then awaits quiescent teardown of every owned PTY. Unpublished backend setup is a tracked lifecycle operation: owner or service disposal aborts its service-owned signal, waits for backend settlement and rollback, and only then returns. Caller cancellation retains its exact `AbortSignal.reason` even when the backend rejects or returns a session whose rollback close fails; that cleanup failure remains tracked for later owner or service disposal instead of replacing the caller reason. A lifecycle-triggered rollback close failure rejects both the spawn and the disposing lifecycle, while `TerminalBackendCleanupError` lets a backend preserve its own failed startup cleanup for the disposing lifecycle without replacing a caller cancellation. When caller cancellation settles before disposal, the cleanup failure remains tracked owner activity until later owner or service disposal consumes and reports it, so sandbox-mode policy cannot mistake failed cleanup for quiescence. Backend or tool-plugin reload does not orphan sessions: ownership lives in `TerminalSessionService` until the agent ends, following the same service-owned-record pattern as [`ctx.jobs`](../../../../packages/jobs/jobs/README.md). The service reserves the session synchronously for one active send before returning its operation, including before a background job id becomes visible; a second send fails with `SEND_ACTIVE`, so output and cancellation cannot cross operation ownership.

### Security and process boundary

A registered `shell` backend constrains how a terminal starts; it does not constrain commands typed after startup. `dsh-terminal-bash` therefore applies two protections before spawning:

- It supplies only terminal-specific environment overrides; the mounted subprocess provider applies the shared credential-shaped-name scrub before merging them.
- It requires the shared `ctx.sandboxPolicy`. At spawn, the backend resolves the owner's effective session mode over the deployment default; `danger-full-access` starts the shell directly, while confined modes require a same-world `ctx.sandbox` provider and wrap the shell argv once. That mode and workspace root remain the process boundary for the PTY lifetime. A write that would change the effective `sandbox/mode` is rejected before commit while the owner has any open PTY or unpublished spawn, with an instruction to wait for creation to settle and close those sessions first; same-effective-mode writes remain valid. The pending reservation spans backend setup through publication, so there is no race in which a wider terminal appears after a downgrade. `danger-full-access` is the existing explicit unconfined choice rather than a PTY-specific bypass.

Sandboxing confines local process effects but does not make arbitrary shell input safe: network calls and other external side effects remain governed by deployment policy. Tool descriptions state that PTY sessions are less auditable than one-shot tools and should be used only when persistence or interactive stdin is necessary.

The local subprocess terminal primitive uses only public `node-pty` capabilities: child PID, `data` and `exit` notifications, `write`, and `kill`. It does not assume access to the native master fd or call `waitpid` from TypeScript. On supported Linux hosts the [native-containment owner](../architecture/2026-08-28-subprocess-native-containment.md) starts that same PTY command inside a user-systemd scope without changing its PID, session, controlling terminal, foreground-group, or readiness semantics. Platform process inspectors below the primitive still derive foreground process groups and fallback parent/child identity from `/proc` on Linux and `ps` on macOS. The [portable execution-world decision](../architecture/2026-07-28-portable-execution-world-consumers.md) owns this process/consumer split.

### Six model-facing tools

| Tool | Purpose | Result |
|---|---|---|
| `terminal_open` | Create an owner-scoped session from a registered backend type | `{ sessionId, name, type, motd }` |
| `terminal_send` | Send text, optionally submit Enter, and wait for readiness or register a background job | bounded viewport plus wait and session status; background also returns `jobId` |
| `terminal_read` | Read a bounded page from retained scrollback | `{ text, totalLines, lineBegin, lineEnd, truncated }` |
| `terminal_signal` | Send one allowed signal to the current foreground process group | `{ delivered, targetPgid }` |
| `terminal_close` | Close one session and await process-tree quiescence | `{ killed }` |
| `terminal_list` | List the caller's live sessions | owner-scoped session summaries |

The UI render contract is exact and location-free. `terminal_send` uses terminal call/result cards only for foreground sends; its background form is generic `execute`. `terminal_open`, `terminal_read`, `terminal_signal`, `terminal_close`, and `terminal_list` use generic `execute`, `read`, `execute`, `delete`, and `read` cards respectively. No PTY tool emits `locations`.

`terminal_send({ sessionId, text, submit?, run_in_background? })` treats `text` as UTF-8 bytes and resolves `submit` to `true` in the tool implementation. When `submit` is true it writes the platform Enter sequence after the text; when false it writes only the text, allowing control characters and REPL fragments without hidden content heuristics. Cancellation marks queued input before signaling the real foreground group, so input cannot execute if an asynchronous pre-write inspection settles afterward. The canceled send retains its reservation until asynchronous foreground signalling settles, so a successor cannot become that signal's target. `enableRunInBackground` defaults to true; false removes `run_in_background` from the schema and rejects the same undeclared argument if a caller forces it through execution.

Foreground sends return a bounded rendered delta and two independent facts: `waitReason` (`stdin_read | inferred_idle | timeout | session_exit`) and `sessionStatus` (`running` or `exited` with exit code or signal). `session_exit` refers to the PTY's top-level shell process, not an arbitrary foreground command whose status the shell consumes. A timeout never implies process exit. `dsh-tool-terminal.maxResultBytes` defaults to 262144, rejects values below 64 so creation acknowledgements retain registry-issued ids, and caps each single-text UTF-8 result after normalized tool or pipeline errors, wait, session, pagination, truncation, generic task-status wrappers, policy denials or short-circuits, and post-execute replacements or blocks; the terminal definitions' last-mile `finalizeContent` callback leaves deliberately structured multi-block policy content unchanged. The renderer reserves suffix space and preserves code-point boundaries instead of treating the backend payload cap as the final model bound.

With `run_in_background: true`, `dsh-tool-terminal` registers the in-flight send on `ctx.jobs` and returns immediately with `jobId`. The producer places `maxResultBytes` on the task snapshot so `job_output`, terminal kill status, and completion notices enforce the same complete-result cap after generic metadata. `job_output(wait: true)` waits, reads incremental output, and records the final result; `job_kill` resolves the current foreground PGID and delivers a real `SIGINT`, including when the application has disabled terminal `ISIG`, and escalates only through the PTY backend's owned teardown path. If the task surface is absent, background mode fails before writing input. No PTY-specific `sleep` tool or general wake-up API is added.

`terminal_read` pages backward from the newest retained line. The backend enforces both line and UTF-8 byte caps on retained scrollback and the returned page payload, so one oversized line cannot bypass the backend bound; the tool then caps the fully rendered page including pagination and truncation metadata. `truncated` distinguishes retention loss from an ordinary viewport delta.

`terminal_signal` accepts the closed set `SIGINT | SIGTERM | SIGKILL | SIGTSTP | SIGHUP`. The backend resolves the terminal foreground process group at execution time. `SIGKILL` is rejected when that group is the top-level shell, directing the caller to `terminal_close`; a failed group lookup fails the operation instead of signaling a guessed PID.

### Local readiness detection

The local backend first recognizes a private OSC prompt marker emitted by its controlled bash startup, then requires the printable tail after the latest marker to exactly equal the controlled `PS1` before declaring prompt readiness and runs three bounded fallback tiers. Carrying that tail across data callbacks covers delivery where the marker and prompt arrive separately; requiring the exact tail rejects a delayed earlier prompt once echoed input or output follows it, so it cannot settle the current send. The marker is removed before output reaches the model and avoids a fixed silence delay for ordinary shell commands on both platforms. Unpublished startup does not accept zero-output silence as readiness; timeout rejects the spawn. If caller cancellation wins during startup, the backend closes the private session and propagates the exact `AbortSignal.reason`; a foreground PGID that is not observable yet cannot replace cancellation with a lookup error. All timings are validated config fields: `pollIntervalMs`, `exactProbeAfterMs`, `idleSilenceMs`, `handoffGraceMs`, and `timeoutMs`.

On Linux, the inspector reads the shell's terminal foreground PGID from `/proc/<shellPid>/stat`, enumerates every process and thread in that process group, and probes their current syscalls. A positive Tier 1 result requires an observed stdin wait: direct `read(0)`, a permitted read of a `select`/`pselect6` or `poll`/`ppoll` argument containing fd 0, or an epoll interest list containing fd 0. The waiting thread's `/proc/<pid>/task/<tid>/fd/0` must identify the shell's controlling terminal device, so a thread-local fd table cannot substitute its leader's terminal descriptor and a pipeline reader blocked on its pipe remains a running command. Direct PTY descriptors use their device number; `/dev/tty` uses the owning process's `tty_nr` because `stat` reports the alias device rather than the selected PTY. A wait already present before terminal input is not post-write readiness: the same PGID must be observed outside that wait before re-entering it, while a changed foreground PGID is new evidence. Unreadable process memory and unrecognized syscalls are misses, never positive guesses. A host policy that denies `/proc/<pid>/task/<tid>/syscall`, including hardened ptrace policy, likewise skips Tier 1 and preserves the bounded Tier 2 idle inference; process sleep state never substitutes for inaccessible syscall evidence. Architecture tables contain only syscall numbers defined by the corresponding Linux UAPI; the inspector admits the runtime architecture, then checks every supported kernel ABI because `/proc` can report a different ABI under user-mode emulation. Unsupported runtime architectures skip Tier 1.

On macOS there is no exact syscall tier. Output silence returns `inferred_idle` for any foreground process group, including Python and `gdb`; `ps`-derived terminal PGID is used for signaling, not as proof that only the shell can be idle. Pure process-inspector logic is injectable and unit-tested on Linux, while a macOS CI job exercises the real PTY and process-table path.

Tier 2 returns `inferred_idle` after `idleSilenceMs` without output. A sleeping or network-blocked command can therefore look ready. When a prompt marker was already seen, Tier 2 waits a further `handoffGraceMs` so a bash foreground handoff that lands on the silence boundary still settles as the exact `stdin_read` attribution instead of the weaker inference; the grace is a deployment-owned config field validated to cover at least one `pollIntervalMs`, because a grace shorter than the poll period cannot contain a single readiness poll and so cannot change any outcome. It bounds only sends that saw a marker, so its cost is the interactive return latency of that one case rather than every send. Tier 3 returns `timeout` after `timeoutMs` so a foreground tool call cannot hold the agent indefinitely. The result preserves the distinction; callers may wait through `ctx.jobs`, signal the foreground group, or inspect from another session.

Once a send settles under any tier, `TerminalSendOperation.append` stops accepting output, so later child output no longer reaches that settled operation; it still reaches the scrollback, and any send that is active when it arrives. A test that waits for a marker on the operation it started must therefore set `idleSilenceMs` and `timeoutMs` above the child's own startup latency; interpreter startup on a loaded macOS runner otherwise ends the send before the marker is printed.

`node-pty` data notifications feed one terminal parser. Parser carry state handles control sequences and a trailing carriage return split across callbacks, so a divided CRLF produces one newline rather than a pagination-changing blank line. The implementation normalizes line-oriented output, but it does not promise correct interaction with a full-screen application.

### Model-visible output and durability

The existing durable `tool/call` and `tool/result` events are the source of truth for text sent by the model and rendered output returned to it. `terminal_open` returns its MOTD through the logged tool result; foreground `send`/`read`/`list`/`signal`/`close` results are logged the same way. The PTY packages do not duplicate raw byte streams into custom session events.

Background sends use the existing task completion notice and `job_output` result path, so any output that reaches a later model request is likewise durable. Raw terminal bytes remain bounded process-local state and are neither persisted nor restorable. A future opt-in transcript sink would need its own retention, credential, and privacy contract.

### Process-tree teardown

On supported Linux hosts, the subprocess terminal handle binds the top-level PTY process to its transient user-systemd scope. Before establishment, close sends `SIGTERM` through the direct PTY fallback so the bootstrap cannot continue; after establishment, it signals the scope alone and uses the direct fallback only if scope signalling fails. It waits for the manager to prove that range empty and escalates to `SIGKILL` after the configured grace. Scope membership continues to include descendants that call `setsid` or reparent, while the PTY's direct exit notification remains the terminal outcome.

Fallback hosts retain observational process-session cleanup. The handle snapshots transitive descendants by parent PID in children-first order, sends `SIGTERM`, waits, rescans for children forked during shutdown, sends `SIGKILL` to the union, and verifies every non-zombie descendant left the process table before stopping the top-level process. A matching Linux zombie has no executable work and therefore counts as quiescent. Every captured PID includes process-start identity so reuse cannot redirect escalation.

Teardown reports top-level exit and survivor cleanup independently. The PTY session does not claim success merely because the shell exited: it calls `SubprocessTerminalHandle.terminate()` and awaits whole-session quiescence, propagating a cleanup failure that names survivors. A failed close is not cached forever: the registry and local session clear the fence only when it still names that failed attempt, so a later explicit or lifecycle close retries without disturbing a newer concurrent attempt. Service disposal still clears its backend, reservation, and owner-detacher registries when a close fails.

### Composition and rollout

The example composition remains opt-in and safe by default:

```yaml
plugins:
  '@deepseek-ai/dsh-sandbox-local':
  '@deepseek-ai/dsh-sandbox-policy':
    config:
      mode: workspace-write
      workspaceRoot: .
  '@deepseek-ai/dsh-terminal':
  '@deepseek-ai/dsh-subprocess-local':
  '@deepseek-ai/dsh-terminal-bash':
    config:
      scrollbackLines: 10000
      scrollbackMaxBytes: 4194304
      maxReadBytes: 262144
      pollIntervalMs: 50
      exactProbeAfterMs: 150
      idleSilenceMs: 3000
      handoffGraceMs: 500
      timeoutMs: 30000
      disposeGraceMs: 3000
  '@deepseek-ai/dsh-tool-terminal':
    config:
      enableRunInBackground: true
      maxResultBytes: 262144
```

The package ships concise tool guidance explaining persistent state, owner isolation, uncertain idle results, cleanup, and the preference for existing one-shot tools when interaction is unnecessary. It does not mount PTY in the base shipped examples: PTY is opt-in through the dedicated composition, while ACP and headless snapshot overlays exercise it. Within an enabled `dsh-tool-terminal` instance, the six tools and `run_in_background` are enabled by default; deployments may disable only the background argument with config.

### Deferred work

- Full-screen TUI support, named key sequences, BEL interruption, terminal resize tools, and alternate-screen snapshots require a separately proven model-facing contract.
- Declarative per-agent startup requires an agent-setup composition point; plugin-load global sessions remain prohibited.
- Session restoration across harness-process loss requires an out-of-process owner and a versioned protocol.
- Network-egress policy and rollback of external side effects are broader than PTY and remain separate security work.
- Windows/ConPTY sessions run through the subprocess-local Windows inspector (Toolhelp32 identities, pseudo foreground groups, taskkill teardown) and the `pty-local` pwsh dialect; see the [pwsh persistent tool note](../../archived/architecture/2026-08-11-pwsh-persistent-pty.md).

## Alternatives considered

**Replace `bash`, filesystem tools, or task tools with PTY.** Rejected. One-shot tools retain stronger validation, approval, sandbox, output-bound, and replay contracts. PTY is reserved for interactive state.

**Add persistent mode to `bash`.** Rejected. Returning on readiness rather than process exit, retaining a process tree across calls, and exposing interactive stdin create a different ownership and failure contract.

**Require native master-fd access from `node-pty`.** Rejected. Its public API exposes no master fd. The local subprocess terminal adapter derives foreground groups and descendants from supported OS process metadata and treats unreadable metadata as a detector miss.

**Signal every member of the root PID's POSIX session.** Rejected. `node-pty` may expose a helper PID whose session belongs to the launcher, so SID-wide teardown can signal unrelated harness or desktop processes. A PID-identity-fenced descendant tree is narrower and safe by construction.

**Publish `TerminalIdleDetector` as a replaceable registry.** Rejected. Substrate-specific foreground facts come from the mounted terminal-process primitive, while prompt/silence readiness remains one private policy in `dsh-terminal-bash`. The filesystem/subprocess execution-world replacement is the necessary extension point.

**Add a PTY-specific `sleep` tool.** Rejected. `ctx.jobs` already owns bounded waiting, cancellation, completion notices, and model-facing collection. A second general wake mechanism would cross the agent-loop boundary and duplicate that contract.

**Include TUI sequences and BEL handling.** Rejected. The source prototype treats those paths as timing-sensitive and still records unresolved alternate-screen and interaction failures. Line-oriented PTY use proves the core value without making those unverified behaviors foundational.

**Use an out-of-process daemon immediately.** Rejected for the initial in-process capability because current long-lived entry points already keep a Cordis context alive. A daemon becomes justified by cross-process restoration or multi-client attachment, both deferred here.

## Verification

- Per-file coverage pins owner fencing, concurrent reservations, cancellation during pre-write inspection, unpublished-spawn cancellation and awaited teardown, sandbox-mode change rejection, retriable lifecycle cleanup, readiness tiers, rejection of pre-write stdin waits and delayed earlier prompts, the configured handoff grace holding the idle fallback past one poll and its rejection below `pollIntervalMs`, sanitizer carry state, complete UTF-8 bounds, task integration, schemas, and exact render intents.
- Subprocess process fixtures cover non-leader and non-main-thread stdin waits, thread-local fd tables, the `/dev/tty` alias, supported kernel ABIs under user-mode emulation, rejection of fd 0 backed by a pipe, zombie quiescence, unreadable process state, unsupported architectures, and other false-positive rejection; macOS inspector logic is injected into the same unit suite.
- Real `node-pty` and PTY-consumer tests jointly exercise shell state, controlling-terminal input through `/dev/tty`, the exact attribution when process syscalls are readable, its bounded idle fallback when host policy denies them, shared sandbox policy, environment scrubbing, raw-mode foreground `SIGINT`, a TERM-ignoring descendant, and immediate post-disposal quiescence. The Linux native smoke keeps the PTY PID, session leader, controlling terminal, foreground `inputWaiting`, and readiness while a reparented `setsid` descendant remains owned by the scope; fallback suites retain identity-fenced observational cleanup coverage.
- A Loader-driven `cordis.yml` test mounts the real three-package composition and verifies that delayed pipeline output returns with the completed command instead of being classified as terminal-input readiness. The SDK minimal snapshot pins that output through the persistent Bash tool; ACP and headless snapshots pin the six terminal schemas, bounded results, and errors through opt-in overlays; TUI snapshots pin terminal and generic card presentation.
- Package contracts, the architecture map, subsystem pages, generated catalogs, and the website API describe the same shipped surface.

## Consequences

**Persistent terminal state is available without weakening one-shot tools.** Shell and REPL state can survive tool calls, while `bash`, `read`, `write`, and `edit` retain their narrower validation, approval, and replay contracts.

**Idle below Linux Tier 1 is heuristic.** Output silence cannot distinguish a prompt from sleep or network I/O. The typed result preserves uncertainty, and bounded timeout plus task waiting and signaling keep control with the model.

**The exact-versus-inferred boundary is a latency trade, not a solvable race.** Attribution depends on whether the kernel publishes the foreground handoff before or after the silence bound elapses, so any fixed grace is a scheduling bet. `handoffGraceMs` puts that bet in deployment configuration: raising it buys exact `stdin_read` attribution on a slow or loaded host at the cost of interactive return latency after a prompt marker, and lowering it does the reverse. Tests that must not depend on the winner assert child-produced output from the next send, using a token absent from echoed input, rather than the attribution.

**Persistent state can drift from the model's belief.** The model may forget its cwd or active REPL. Session summaries and retained output help recovery, but no prompt can make state persistence deterministic.

**Native Linux ownership closes the process-tree observation gap; fallback ownership does not.** A supported user-systemd scope retains a daemonized or reparented descendant as a member until the scope becomes empty. On macOS, Windows ConPTY, and Linux hosts that cannot establish the scope, a process that escapes before observational teardown can still evade the captured tree; the fallback accepts that gap instead of risking SID-wide signals to unrelated processes.

**A shell can cause external side effects.** Session sandboxing and environment scrubbing reduce local exposure but do not undo pushes, API calls, or messages. Deployments that cannot tolerate those effects must omit PTY or add network policy.

**Process loss destroys terminal state.** In-process sessions do not survive a harness crash or restart, and raw scrollback is not durable. Important work must be committed to files or another durable system.

**`node-pty` is a native dependency of `dsh-subprocess-local`.** Installation, supported Node versions, prebuild availability, and platform behavior require built-artifact smokes on every supported OS.
