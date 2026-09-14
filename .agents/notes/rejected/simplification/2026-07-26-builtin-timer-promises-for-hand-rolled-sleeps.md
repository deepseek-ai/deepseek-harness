# Agent Note: Use node:timers/promises for hand-rolled cancellable sleeps

Status: rejected — implementation (PR #679) falsified the parity premise: vitest's fake clock does not intercept `node:timers/promises`, so the swap costs deterministic fast tests for ~10 deleted lines

English | [中文](2026-07-26-builtin-timer-promises-for-hand-rolled-sleeps.zh.md)

## Problem

Three packages hand-roll promise-wrapped timers that the `node:timers/promises` builtin already provides, while other packages (`dsh-llm-mock-server` `pause()`, `dsh-lsp-stdio`, `dsh-acp-snapshot`) already use the builtin — so the hand-rolled copies are also a consistency gap:

- `packages/llm/llm-retry/src/index.ts` `cancellableDelay()` (~14 lines): `new Promise` + `setTimeout` + manual abort-listener add/remove, resolving `true` on elapse and `false` on abort, consumed once for the backoff wait.
- The former `workflow-worker-thread` host's `sleep()` (~7 lines, evaluated in PR #679): promise-wrapped unref'd `setTimeout` used as the dispose-grace bound.
- `packages/terminal/terminal-bash/src/session.ts` `delay()` (~4 lines): bare promise-wrapped `setTimeout` used in polling/teardown waits.

## Proposal

Replace all three with `import { setTimeout } from 'node:timers/promises'`:

- llm-retry: `try { await setTimeout(delayMs, undefined, { signal }); /* retry */ } catch { /* abort → fail */ }` — with a signal, the promise rejects only with the abort error, and a pre-aborted signal rejects immediately; behavior is identical, including timer clearing on abort. The empty `catch` names the abort rejection per the repo's empty-catch rule.
- workflow-worker-thread: `setTimeout(ms, undefined, { ref: false })` — exact semantics including not holding the event loop open.
- terminal-bash: `import { setTimeout as delay } from 'node:timers/promises'` — identical signature, call sites unchanged.

No dedicated tests pin the helpers themselves; the packages' behavior suites keep passing.

## Alternatives considered

- **`p-timeout`/`p-defer` style packages.** Rejected: the builtin covers both call sites exactly; an external package for a one-line await is negative-net.
- **Leave them.** Rejected only weakly — the cost is small, but the repo already uses the builtin idiom elsewhere, and two hand-rolled variants of a builtin invite a third.

## Acceptance criteria

- None of the three packages defines a promise-wrapped `setTimeout` helper; all import from `node:timers/promises`.
- The `llm-retry`, `workflow-worker-thread`, and `terminal-bash` test suites pass unchanged (behavioral parity).

## Risks

Essentially none: no model-visible output, no platform concerns, no new dependency. The llm-retry rewrite changes a boolean-returning helper into try/catch control flow — a local readability judgment the implementing PR makes.
