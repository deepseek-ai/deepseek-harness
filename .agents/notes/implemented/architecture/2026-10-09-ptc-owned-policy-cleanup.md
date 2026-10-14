# Agent Note: PTC owns policy-change cleanup waits

Status: implemented

English | [中文](2026-10-09-ptc-owned-policy-cleanup.zh.md)

## Problem

Stopping a retained Node process and its nested tools can take longer than recording a new file policy. Making permission setters await that cleanup spreads PTC lifecycle requirements into unrelated callers, including Webhook Session creation, and adds cancellation windows to those callers.

## Decision

Permission setters commit synchronously. Success means the selected policy is recorded; it does not guarantee that operations admitted under the old policy have completely stopped. This replaces the completion requirement and cleanup ownership in the [retained-process sandbox decision](2026-10-08-persistent-ptc-sandbox.md), whose confinement and one-time escalation rules still apply.

PTC observes committed Session mode changes. The tool bridge immediately cancels affected complete calls, including pending approvals and nested tools. A later PTC call waits for canceled predecessors to settle before resolving the latest standing policy. The Node provider immediately invalidates affected processes, including idle environments, starts cleanup, and retains the cleanup Promise internally. A later program waits for that cleanup; failed cleanup remains retryable and prevents process reuse. Unchanged modes preserve environments. Tool-registry and provider unload remove their observers and await owned work.

## Alternatives considered

**Wait in permission setters.** This provides a definite completion point for old-authority work, but no current permission consumer requires that guarantee. It introduces a general resource registry and asynchronous API migration for PTC-specific cleanup. The completion guarantee belongs to PTC execution and disposal instead.

**Clean up only on the next PTC call.** An idle environment can retain background work indefinitely when no further call occurs. Policy changes begin cancellation immediately; only waiting is deferred.

**Reconfigure an existing process.** The sandbox applies restrictions at launch. Open handles, retained objects and background work require releasing the old environment before another policy can execute there.

## Consequences

Permission changes return without process-cleanup latency. Old operations may remain active while cancellation finishes, and cleanup failure does not roll back the recorded policy. Subsequent PTC execution waits for cleanup and uses the latest policy. Webhook creation keeps its synchronous permission step, so that step adds no cancellation window before prompt admission. Regression coverage holds cleanup with explicit barriers, changes policy again while a call waits, checks idle cancellation without another call, and verifies cleanup retry and owner unload.
