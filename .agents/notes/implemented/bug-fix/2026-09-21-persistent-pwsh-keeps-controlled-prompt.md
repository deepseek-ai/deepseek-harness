# Agent Note: Persistent pwsh keeps the backend's controlled prompt

Status: implemented

English | [中文](2026-09-21-persistent-pwsh-keeps-controlled-prompt.zh.md)

## Problem

`dsh-tool-pwsh-persistent` initialized its shell with a `prompt` function of its own (`'__DSH_PERSISTENT_PWSH_PROMPT__ '`), overwriting the `prompt` that `dsh-terminal-bash` installs in its pwsh startup sequence. The backend's prompt readiness requires the printable tail after the OSC `133;D` marker to exactly equal the controlled `dsh> ` prompt ([design](../feature/2026-07-16-persistent-pty-sessions.md)), so after initialization no send could settle through it and every send paid the silence tier plus handoff grace. Measured on Windows through the real Loader composition with production defaults: 8493 ms for the first call (spawn, initialization, and command) and 3722/3832/3759 ms for the next three, against 1340/255/251/241 ms with the controlled prompt intact. The package tests masked it by configuring `idleSilenceMs: 300`.

The [persistent bash tool fixed the identical defect](../../archived/bug-fix/2026-08-15-persistent-bash-keeps-controlled-prompt.md) by giving up its own prompt override; the pwsh twin kept it. The override served the same two consumers there: a viewport-suffix fallback detecting "shell at a prompt without the end marker", and cosmetic stripping of prompt text from partial output.

## Decision

The tool no longer installs a prompt. `dsh-terminal-bash` owns the pwsh `prompt` function, installs it during `spawn`, and returns the session only after that startup reached `stdin_read` readiness, so the tool's initialization send had nothing left to establish and is deleted together with its `PWSH_PROMPT_SETUP` command.

The viewport-suffix fallback is replaced with the seam's own signal: a send that settles as `stdin_read` without the end marker in scrollback returns the captured partial output. The private prompt constant and its stripping are deleted; partial output may now end with the backend's own prompt text, which the tool cannot and should not know. `stripPrompt` collapses to `trimTrailingNewline`, matching `dsh-tool-bash-persistent`.

## Alternatives considered

**Align the tool's prompt text with the backend's `dsh> `.** Rejected: it keeps a second installation of one protocol constant and a second owner of it, and the send is redundant because the backend had already installed the identical prompt before `spawn` resolved.

**Import the controlled prompt into the tool.** Rejected: the prompt is one provider's protocol constant; a Consumer matching it would couple the tool to `dsh-terminal-bash` specifically, and any other mounted pwsh-dialect backend would break it again.

**Lower `handoffGraceMs`/`idleSilenceMs` instead.** Rejected: no silence value fixes a dead fast path; it rebalances how much every call overpays, and the silence tier is also what absorbs a genuinely broken prompt.

**Re-assert the pwsh prompt per prompt, as `PROMPT_COMMAND` does for bash.** Rejected: PowerShell has no per-prompt hook outside the `prompt` function itself, so a redefinition cannot be healed the way bash's variable is; the residue stays a documented limitation.

## Consequences

Windows, production defaults, real Loader composition: tool calls drop from 8493/3722/3832/3759 ms to 1340/255/251/241 ms (spawn + initialization + first command, then three warm commands).

The `stdin_read` fallback is behavior, not only cosmetics: where a provider proves a foreground stdin wait, an interactive child returns captured partial output instead of spinning to the command deadline, and elsewhere the call still runs to `timeoutMs`. That early return keeps the session, so a child still reading stdin can consume the next call's command until that call reaches `timeoutMs` and resets the shell; `dsh-tool-bash-persistent` behaves the same way, and distinguishing the shell's own prompt readiness from a child's stdin wait belongs to the seam rather than to either tool. Complete marker-delimited output is unchanged.

The loader-composition suite records every send's `waitReason` and requires at least six `stdin_read` settlements and no `inferred_idle`: the regression is reported by the settle reason itself, not by how long silence takes. Reinstating the removed prompt override fails that assertion after 30 s with `expected 0 to be greater than or equal to 6`, while the case's output assertions still pass. The stub suite drops the initialization-handshake modes and pins the prompt text retained in partial output instead of its absence.

A model command that redefines `prompt` still removes the readiness marker and degrades later sends to the silence tier: the backend installs its prompt once at startup and cannot re-assert it.
