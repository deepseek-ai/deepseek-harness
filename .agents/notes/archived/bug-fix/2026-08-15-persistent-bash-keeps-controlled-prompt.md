# Agent Note: Persistent bash keeps the backend's controlled prompt

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-15-persistent-bash-keeps-controlled-prompt.zh.md)

## Problem

`dsh-tool-bash-persistent` initialized its shell with `stty -echo; PS1='__DSH_PERSISTENT_BASH_PROMPT__ '`, overwriting the `PS1` that `dsh-terminal-bash` sets in the spawn environment. The backend's prompt readiness requires the printable tail after the OSC `133;D` marker to exactly equal the controlled prompt ([design](../feature/2026-07-16-persistent-pty-sessions.md)), so after initialization no send could ever settle through it. `PROMPT_COMMAND` survived the override, so the marker kept arriving and every send paid the silence tier plus handoff grace — 3.5 s per tool call under production defaults, 7.2 s for the first call because the initialization send degraded too, and an extra 3.5 s tail after every long command. macOS has no exact stdin-wait tier, and on Linux the exact probe cannot observe a sub-poll-interval command leaving its stdin wait, so the degradation applied to effectively every call. Package tests masked it by configuring `idleSilenceMs: 100`.

The override existed to give the tool a known prompt for two consumers: a viewport-suffix fallback that detected "shell at a prompt without the end marker", and cosmetic stripping of prompt text from partial output.

## Decision

The backend owns its prompt protocol and repairs it itself: the controlled `PROMPT_COMMAND` re-asserts `PS1` after printing the marker, so any in-shell prompt override — this tool's former initialization, a model command, a sourced script — lasts zero prompts. This also protects providers that cannot report foreground state, where the exact prompt text is the only readiness evidence.

The tool stops overwriting `PS1` (initialization is `stty -echo` alone) and replaces its viewport-suffix fallback with the seam's existing signal: a send that settles as `stdin_read` without the end marker in scrollback returns the captured partial output. The private prompt constant and its stripping are deleted; partial output may now end with the backend's own prompt text, which the tool cannot and should not know.

## Alternatives considered

**Fix only the tool, leaving `PROMPT_COMMAND` unchanged.** Rejected because the seam would stay silently fragile: any later consumer or model command that touches `PS1` reintroduces the 3.5 s degradation with no failing signal, and providers without foreground inspection lose their only readiness factor.

**Import the controlled prompt into the tool.** Rejected because the prompt is one provider's protocol constant; a Consumer matching it would couple the tool to `dsh-terminal-bash` specifically, and any other mounted backend would break it again.

**Drop the prompt-text factor from backend readiness.** Rejected because for providers whose `inspectForeground` reports nothing, marker-plus-text is the defense against command output that embeds the raw OSC marker sequence; weakening it trades a fast path for a false-settle risk.

**Widen `handoffGraceMs`/`idleSilenceMs` tuning instead.** Rejected because no silence value fixes a dead fast path; it only rebalances how much every call overpays.

## Consequences

Measured on darwin with production defaults: raw sends settle in ~86 ms with the controlled prompt intact versus ~3540 ms after an override; tool calls drop from 7180/3560/3566 ms to 355/88/91 ms for spawn+init+echo, echo, and pwd.

The `stdin_read` fallback is behavior, not only cosmetics: after `exec`, an interrupt, or an interactive foreground child whose stdin wait the provider proves (the Linux exact tier), the call now returns captured partial output instead of spinning to the command deadline. Where no provider proves the wait (macOS), an interactive child still runs to `timeoutMs` — recorded as a known limitation in the tool README. Partial output can carry the backend's trailing prompt; complete marker-delimited output is byte-identical to before, which the keyless jsonrpc-agent snapshots confirm.

The loader-composition suite now sets `idleSilenceMs` above the send bound, so silence can settle nothing and every case fails if prompt readiness regresses; a real-PTY case overrides `PS1` in-shell and requires the next send to settle as `stdin_read` with the healed prompt. The self-repair cannot survive a command that overwrites `PROMPT_COMMAND` itself; the silence tier remains the bound there, unchanged from the prior design.
