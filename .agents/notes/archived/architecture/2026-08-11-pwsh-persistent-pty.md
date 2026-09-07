# Agent Note: Persistent pwsh over the terminal seam on Windows

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-11-pwsh-persistent-pty.zh.md)

## Problem

The harness had no persistent shell on Windows. The persistent `bash` stack was POSIX-only by construction: `@deepseek-ai/dsh-subprocess-local` threw at terminal allocation (`createProcessInspector()` rejected win32), `@deepseek-ai/dsh-terminal-bash` was bash-shaped (`/bin/bash` defaults, `PS1`/`PROMPT_COMMAND` environment markers), `@deepseek-ai/dsh-tool-bash-persistent` wrapped commands in bash syntax, and every pty test skipped on win32. The one-shot `pwsh` tool (`@deepseek-ai/dsh-tool-pwsh` over `@deepseek-ai/dsh-pwsh-local`) already ran on Windows, but each call started a fresh `pwsh -Command` process: cwd, `$env:` variables, functions, and interactive children ended with the call, and its README recorded "No persistent shell or PTY" as deferred work.

The gap excluded Windows workflows whose state lives in a terminal: stepping a debugger, exploring in a Python or Node REPL, or returning to a shell after interrupting its foreground command — the same class of work the persistent bash pty serves on POSIX.

Two foundations already existed. the terminal service itself (`ctx.terminals` registry, owner scoping, send/read/signal/kill contract) is platform-neutral. The Loader's `disabled: !!js` interpolation (PR #2234) gates shell rows per platform and pins the invariant that exactly one shell stack mounts per host; a persistent pwsh stack composes through the same rows.

## Decision

A model-facing persistent `pwsh` tool ships on Windows with the same contract as `tool-bash-persistent`: one owner-scoped persistent shell per Agent, marker-detected command completion, exact native exit codes, bounded output, and timeout/cancel/`exit` semantics that reset the shell and tell the model. Three pieces deliver it: a Windows substrate in `subprocess-local`, a shell-dialect option in `terminal-bash`, and the new `tool-pwsh-persistent` package with the minimal-preset composition rows.

### Windows substrate in `@deepseek-ai/dsh-subprocess-local`

`createProcessInspector()` returns a `WindowsProcessInspector` on win32 instead of throwing. The koffi-backed inspector enumerates the process table through Toolhelp32, combines GetProcessTimes creation identities with zero-time process-handle waits (pid-reuse fencing plus terminated-object detection), reports the **shell pid as a pseudo foreground group** (Windows has no POSIX groups; the stable value lets the prompt-marker readiness fast path settle in one poll interval), reports no stdin-wait evidence (readiness degrades exactly like macOS), and signals through `taskkill /T` escalation (`/F` only for SIGKILL). koffi (`^3.1.0`, the version `sandbox-windows-acl` already pins) loads lazily on win32 only.

`LocalTerminalHandle` branches for win32 because node-pty's `kill(signal)` throws ("Signals not supported on windows") and its bare kill delegates to a console-list agent that fails without a parent console. Teardown escalates through taskkill fenced on the shell's start identity, and — because an externally taskkilled shell may never fire node-pty's exit notification — the handle settles `done` from the inspector-verified absence (`settleExitIfGone`). `signalForeground` maps SIGINT to a `\x03` Ctrl-C input write (the console-wide delivery conhost turns into a CTRL_C event; verified to interrupt a running command), routes SIGTERM/SIGKILL to taskkill, and rejects SIGTSTP/SIGHUP as unavailable on Windows. The public `PtySignal` set and seam types are unchanged; the mapping lives in the backend.

### Shell dialect in `@deepseek-ai/dsh-terminal-bash`

One backend, two dialects: `shellDialect: 'bash' | 'pwsh'` (default `'bash'`; the bash argv and environment defaults remain unchanged). The effective `shellPath`/`shellArgs` resolve per dialect (bash `/bin/bash --noprofile --norc -i`; pwsh through the shared `dsh-pwsh-local` resolver with `-NoLogo -NoProfile`, keeping the interactive host for child REPLs). The child environment drops the bash-only `PS1`/`PROMPT_COMMAND` markers and adds `NO_COLOR` for pwsh. pwsh cannot install its prompt from the environment, so the backend writes the prompt function through the session at startup and accepts only the backend's `stdin_read` result; a printable prompt literal in echoed setup input is not readiness. One `timeoutMs` deadline owns the complete startup retry loop, so `inferred_idle` follow-up sends cannot restart the bound. A zero-scrollback `@xterm/headless` instance consumes raw PTY data and emits terminal-protocol replies through `SubprocessTerminalHandle`; the backend drains those writes before caller input and accepts foreground state only when protocol work stayed quiet throughout inspection, so a caller's input cannot be consumed as a cursor-position response. One parser write stays active while later raw chunks coalesce into the next batch, preventing high-volume output from creating one scheduled parse per chunk. The existing sanitizer and bounded buffers remain the output projection. Both dialects emit the same BEL-terminated OSC `133;D;` marker, so `PROMPT_MARKER_PREFIX`, `CONTROLLED_PROMPT`, and the exact-tail readiness logic stay shared — the marker remains a readiness signal with an unconsumed payload, and the deferred BEL event channel stays deferred.

### `@deepseek-ai/dsh-tool-pwsh-persistent`

A new package mirroring `tool-bash-persistent`: same `Config` (`backendType` default `shell`, `timeoutMs`, `maxOutputChars`, `description`), same owner-scoped shell registry and serialized per-owner queue, same timeout/abort/exit/reset paths. The tool name is `pwsh`; it never co-mounts with the one-shot `tool-pwsh` because the preset rows are mutually exclusive per platform.

Commands run through a wrapper that resets `$LASTEXITCODE` (assignable, verified), invokes the body via `Invoke-Expression` in a backtick-escaped double-quoted string (`quoteForPwsh`: backtick, quote, `$`, CRLF, and ESC escapes, so no raw control characters ride the input line and the wrapper survives ConstrainedLanguage), and reports the exact native exit code, `1` for a terminating PowerShell error, or `0` for success. PSReadLine echoes the submitted wrapper back into the stream — there is no `stty -echo` equivalent — so the extraction strips the wrapper source from captured output; the echo can never fabricate completion because the status regex needs digits immediately after the END nonce and the echo continues with quote characters. The prompt function installs the tool's own prompt (`__DSH_PERSISTENT_PWSH_PROMPT__ `) over the backend bootstrap value, the same two-layer structure as bash.

### Composition

The minimal preset gates its persistent shell stack by platform with the #2234 `disabled: !!js` interpolation: the bash rows (`terminal-bash` + `tool-bash-persistent`) mount on POSIX, and the pwsh rows (`terminal-bash` with `shellDialect: pwsh` + `tool-pwsh-persistent`) mount on win32 — exactly one persistent shell per host. `windows-shell.spec` pins the per-platform roster; the real Loader composition exercises the whole stack over a real ConPTY pwsh.

### Testing

The Windows test surface follows master's exemption structure: terminal-bash and subprocess-local tests stay excluded on win32 (`windowsUnsupportedTests`) and their sources stay coverage-exempt there (`windowsUnsupportedCoveragePackages`), so the platform-gated fixtures and node-translated commands remain the win32 dev-lane evidence, while the koffi-backed inspector joins the windows-only coverage exclusions on Linux. `tool-pwsh-persistent` is not exempt: its suite runs and its sources are coverage-required on the windows-native lane, mirroring `tool-bash-persistent`'s stub-mode matrix plus an echo-stripping mode. The session suite pins split cursor-position queries, response-write ordering, and parse batching without a real shell; real-pwsh suites on macOS and Windows prove persistent cwd/env, secret scrubbing, UTF-8 output, multiline and here-string commands, large-output clipping, and exit/reset. The ACP keyless snapshot boots the persistent tool through a real Loader composition and pins its model-visible schema and result.

## Alternatives considered

- **A separate `pty-pwsh-local` backend package.** Rejected: the local session, sanitizer, readiness tiers, and sandbox fence are shared machinery; duplicating the 500-line session for argv/env/startup differences trades one config field for a package of copy-paste, unlike the bash group's thin parallel executors.
- **tasklist or wmic polling for the process tree.** Rejected: `inspectForeground` runs on every readiness poll (~50 ms), so a spawned probe per tick is untenable, and wmic is removed from current Windows releases. koffi + Toolhelp32 is in-process and cheap.
- **A native helper or `GenerateConsoleCtrlEvent` for SIGINT.** Rejected: writing `\x03` to ConPTY input interrupts running commands (verified) with zero new code. The semantic difference — at a prompt, `\x03` cancels the pending line instead of signalling a process — is documented rather than engineered around.
- **Base64 body encoding for the wrapper.** Rejected: decoding needs `[Convert]`/`[System.Text.Encoding]` calls whose ConstrainedLanguage status is unproven, while backtick-escaped double-quoted strings use only language-level constructs and were verified end-to-end.
- **Hand-written cursor-position replies.** Rejected: the response must reflect cursor movement, wrapping, and control sequences already emitted by the shell. Fixed coordinates amplify console redraws and can exhaust bounded output; `@xterm/headless` maintains that protocol state without replacing the line-oriented output projection.
- **Tolerating the echo without stripping the wrapper.** Rejected: in complete and prompt-settled paths the echo is naturally excluded, but timeout and lost-START fallbacks would leak the wrapper source (including marker nonces) into model-visible text.
- **Resurrecting a BEL model-notification channel.** Rejected: the current implementation consumes no marker payload and delivers no BEL events; the design aligns with the current implementation and keeps the deferred item deferred.
- **Windows PowerShell 5.1 as a first-class target.** Rejected: pwsh 7 (including the Store install) is the target; `resolvePwshPath` keeps 5.1 as the last-resort executable fallback without promising full persistent-shell behavior on it.

## Consequences

**Windows became a first-class persistent-shell host.** The persistent pwsh stack runs and is coverage-gated on the windows-native lane; the one-shot/persistent shell split mirrors POSIX, and the preset spec pins exactly one shell stack per host on both platforms.

**Windows coverage keeps master's exemption structure.** subprocess-local and terminal-bash sources stay coverage-exempt and their suites test-excluded on win32 exactly as on master; the Windows code paths are exercised through the win32 dev lane and the real-pwsh tool suites, and the new surface's coverage obligation on the windows-native lane sits on `tool-pwsh-persistent`.

**Windows readiness is weaker than Linux.** The pseudo-pgid marker fast path covers shell prompts, but a child without a prompt settles on the silence tier (~3 s), exactly like macOS; there is no exact stdin-wait tier.

**Windows teardown and signalling differ from POSIX.** taskkill without `/F` does not terminate console processes (the TERM tier is a grace wait before `/F`), SIGINT is console-wide Ctrl-C, SIGTSTP/SIGHUP are unavailable, and externally taskkilled shells may not fire node-pty's exit notification — the handle settles from verified absence instead.

**Input echo is an accepted platform fact.** PSReadLine echoes submitted input; the marker-anchored extraction and wrapper-source strip remove it in complete results, with bounded residual in partial-output fallbacks.

**Terminal protocol replies precede caller input.** The headless emulator retains no scrollback and contributes no model-visible text; it tracks terminal control state and emits replies through the mounted subprocess provider. This adds the maintained `@xterm/headless` runtime dependency and prevents a cursor query from consuming a later tool command.

**Risks carried.** Under the Windows ACL sandbox's read-only mode, ConstrainedLanguage may deny the bootstrap's `[Console]::` encoding pin and prompt marker; if marker readiness remains unavailable, startup rejects at `timeoutMs` instead of publishing a shell whose setup did not complete. A later model redefinition of the `prompt` function degrades command readiness to the silence tier. Raw ESC characters in model commands are unsupported (PSReadLine consumes them). koffi and `@xterm/headless` add process-substrate and terminal-backend dependency review respectively.
