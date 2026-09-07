# Agent Note: Keep one public stop primitive

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-20-public-agent-stop-api.zh.md)

## Problem

The public `Agent` handle exposed two overlapping ways to stop in-flight work: step-only `abort()` and queue-aware `cancel()`. The former preserved queued input while the latter originally only exposed its broad default, which clears queued and steering work while aborting the active turn. `cancel(cause, { keepInbox: true })` now covers the production Web stop policy without exposing the private turn holder; ACP retains broad cancellation, while lifecycle owners tear down agents through `AgentHandle.dispose()`. No production caller needs a bare step-only abort.

The behavioral distinction is real, but no shipping code needs a separate narrower verb. AgentLoop owns one private cancellation holder for the whole turn. `cancel(cause, options?)` carries an explicit typed `user` or `parent` cause; its broad default drops pending input, while `keepInbox` preserves pending work for later turns. Disposal remains a separate lifecycle interruption. The complete ownership and propagation contract lives in the [explicit turn cancellation note](../architecture/2026-07-16-explicit-turn-cancellation.md).

The extra surface area made the loop carry a public verb that was mostly a teardown internal. An options-bearing `cancel()` expresses caller policy without exposing a second holder-shaped operation.

## Decision

`cancel()` is the only public *stop* primitive on `Agent`. Lifecycle owners use `AgentHandle.dispose()` to stop and unregister an agent; non-owners use broad `cancel()` to abandon current and queued work or `keepInbox` to abort the active turn while retaining pending work. The implementation keeps a private turn cancellation holder, but it is not part of the plugin-facing `Agent` contract. The [Web stop decision](../bug-fix/2026-07-31-web-stop-preserves-queue.md) is the production `keepInbox` consumer.

`whenIdle()` is **retained** as the public quiescence-observation primitive (resolve once the agent settles out of `running`, resolve immediately when already idle, await the loop exit when disposed). It is not a stop verb; it is how a non-owner observes the stop *completing* without disposing the agent. Its live consumers are ACP and agent tests that await settlement through this public contract (`packages/acp/acp/tests`, `packages/core/agent-loop/tests`); the production ACP bridge owns its agents and tears them down through `AgentHandle.dispose()`, so `packages/acp/acp/src` itself has no `whenIdle()` call.

Public `abort()` is absent, and the disposer remains async and waits for the loop to stop. Tests exercise cancellation through the public typed cause and explicit signal APIs rather than reaching into the holder.

## Alternatives considered

**Removing `whenIdle()` too** — the original proposal's shape, reversed on validating the premise against the code: it is a load-bearing quiescence primitive that safely handles waiter settlement and replacement-turn races, and pushing consumers onto hand-observed `running`→`idle` transitions is exactly the brittle path the defensive patterns warn against.

## Verification

`Agent` exposes no public `abort()` while `cancel()`, `whenIdle()`, and `steer()` remain; ACP cancellation calls broad `cancel()`, Web stop calls `cancel(..., { keepInbox: true })`, and teardown awaits quiescence through handle disposal. `whenIdle()` resolves on quiescence for non-owner observers, and the suites cover cancellation and disposal as the two supported stop paths.

## Consequences

A plugin can abort the active turn while preserving queued prompts through `keepInbox`, but it cannot abort only one model/tool step while leaving that turn running. A step-only use case would need a named consumer and a narrower contract; exposing the private loop mechanic remains unjustified.

## Related

This Agent Note only removes the redundant stop verb. Mid-turn steering remains an intentional message path; quiescence observation remains via `whenIdle()`. The resulting delivery surface is `followup()`, `steer()`, and `inject()`; stopping and observation remain with `cancel()` and `whenIdle()`.
