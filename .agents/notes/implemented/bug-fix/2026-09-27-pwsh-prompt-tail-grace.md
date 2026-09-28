# Agent Note: A seen prompt marker keeps its own tail grace

Status: implemented

English | [中文](2026-09-27-pwsh-prompt-tail-grace.zh.md)

## Problem

Windows sessions on the self-hosted lane settled one or two of seven sends on the controlled prompt and charged the silence tier for the rest (2026-09-25/26, issue #2487). The exact readiness evidence is the controlled prompt's printable tail after the OSC `133;D` marker, and the bound on waiting for it was `idleSilenceMs + handoffGraceMs`. A native Windows probe shows the render arrives as two pty chunks: the marker alone, then the five-byte `dsh> ` 2-28 ms later (56 renders), with nothing printable after any prompt and no terminal queries in the output. The marker is written by the shell's own prompt function and the tail by the same render, so a tail that arrives past the bound means the host stalled that delivery, not that the prompt is absent. The session settled `inferred_idle` anyway, and each such send cost the tool call roughly three seconds.

## Decision

`dsh-terminal-bash` gains a validated `promptTailGraceMs` configuration field, default `0`. While a send has seen the prompt marker and its printable tail has not arrived, the silence bound becomes `idleSilenceMs + handoffGraceMs + promptTailGraceMs`; every other bound, wait reason, and code path is unchanged. The [persistent PTY readiness design](../feature/2026-07-16-persistent-pty-sessions.md) owns the tier ladder this bound extends. Zero reproduces the previous bound exactly, so an upgrade changes no deployment's behaviour. The persistent pwsh Loader-composition case sets 5000 ms, because the hosts whose stalls the field is for are exactly the ones that run it, and its assertion (at least six `stdin_read` settlements, no `inferred_idle`) then measures the controlled-prompt path instead of the host's delivery timing. `validateConfig` accepts zero for this field — the one numeric bound whose zero is a documented value — and rejects negative or fractional values.

## Alternatives considered

**Raise the default instead of adding a field.** Rejected: it trades one fixed cost for another on every host. A marker whose tail never arrives (a stray marker from a child, a broken prompt function) would then fall back that much later everywhere, while the timing that matters differs per deployment.

**Make the observation sticky: once the exact tail was seen, let later output stand.** Rejected: the tail rule exists to prove the marker was followed by the prompt text rather than by a command's output, and a sticky flag would settle a send while that command is still printing.

**Wait for the tail up to the absolute `timeoutMs` once a marker was seen.** Rejected: a prompt that never completes its render would hang every send until the tool deadline instead of falling back after a bounded silence, and the send budget belongs to the caller.

**Detect the stall in the test and retry the send.** Rejected: retries hide which tier settled a send, and the durable fix belongs where the evidence is interpreted, not where it is measured.

## Consequences

A deployment whose console renderer stalls keeps those sends on the exact path by setting `promptTailGraceMs`; the default path is bit-for-bit the previous bound, so the negative control — the same delayed tail with the field at zero — still settles `inferred_idle`. The tolerance applies only after a marker was seen: a missing prompt keeps the plain silence bound, so the regression the Loader-composition case pins (a lost prompt must fail) is still caught, and a marker whose tail never arrives falls back one configured interval later.

## Testing

`packages/terminal/terminal-bash/tests/session.spec.ts` pins every state with fake timers: with `promptTailGraceMs` set, a marker whose tail arrives after the plain bound stays pending and then settles `stdin_read`; a marker whose tail never arrives falls back to `inferred_idle` at the extended bound; a tail that arrived and was invalidated by later output keeps the plain bound; and with the field at zero the same delayed delivery settles `inferred_idle`. `packages/terminal/terminal-bash/tests/config.spec.ts` accepts zero and rejects negative or fractional values, and rejects a nonzero tolerance shorter than one `pollIntervalMs`. `packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` carries the end-to-end evidence on native Windows: with every session's prompt tail withheld for four seconds the case passes with the configured tolerance — nine settles, eight `stdin_read` and the `exit` command's `session_exit`, in 33.4 s and 37.5 s — and fails with the tolerance patched to zero, where two sends settle `inferred_idle` with `promptSeen` true, `promptTextSeen` false, an empty tail and `idleFor` 3312-3316 ms.
