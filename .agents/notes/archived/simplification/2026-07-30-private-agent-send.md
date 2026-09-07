# Agent Note: Keep agent routing private

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-private-agent-send.zh.md)

## Problem

The public `Agent.send()` method exposed the concrete loop's routing matrix even though production callers use only the semantic `followup()`, `steer()`, and `inject()` operations. Its fourth combination, `next-turn` with `wakeup: false`, had no consumer beyond tests. Keeping that latent capability public also required alternate `Agent` implementations and test fakes to accept implementation-level routing policy.

## Decision

`Agent` exposes `followup()`, `steer()`, and `inject()` as its complete delivery contract. `ReactLoopAgent` keeps a private `send()` helper that shares routing mechanics among those methods, while `SendTarget` and `SendOptions` are no longer exported from `dsh-agent`.

The public interface cannot queue a turn without waking the driver. A follow-up always requests execution, steering requests the nearest step, and injection supplies model-facing context without requesting execution. This partially supersedes the public-surface portion of the [unified delivery decision](../architecture/2026-07-22-unified-send-and-coalesced-user-messages.md) while retaining its internal routing and unified `user/message` representation.

## Alternatives considered

**Keep the routing matrix public.** This preserves the unused quiet-queue combination, but exposes mechanism instead of caller intent and imposes it on every alternate driver.

**Add a public quiet-queue method.** A named method would be clearer than raw routing flags, but no production workflow currently needs work that remains parked until an unrelated delivery wakes it.

## Consequences

Plugins choose among three semantic operations instead of constructing routing options. Alternate drivers and structural test fakes implement a smaller contract, and the Cordis API catalog no longer advertises `send`, `SendTarget`, or `SendOptions`.

The removed quiet-queue capability can return only with a named consumer and explicit lifecycle semantics. `cancel({ keepInbox: true })` still preserves work already pending through the supported delivery paths.
