# Agent Note: Merge subagent control into the subagent service

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-26-merge-subagent-control-service.zh.md)

The public operation set is refined by [Intent-named subagent continuation operations](2026-07-27-intent-named-subagent-continuation-operations.md) and again by [Continuable subagents](../feature/2026-07-28-continuable-subagent-conversations.md), which keeps the single merged service while removing provider `resume` dispatch and the Task-backed continuation lifecycle.

## Problem

Continuable-child orchestration originally lived in a separate `ctx.subagentControl` service above the raw `ctx.subagents` provider contract. That split kept provider dispatch independent of Jobs and persistence, and gave model and human adapters one orchestration contract. In practice the two services described one capability family, every continuable caller needed both, and the provider-bound delegation tool had to infer policy from `provider.resume` and inspect whether the control service and `send_message` tool happened to be loaded. This made sibling plugin presence decide execution semantics and coupled starting continuable work to an optional follow-up surface.

## Decision

`SubagentRuntime` is the only public service. It exposes ordinary `start(name, request)`, Task-backed `startContinuable(spec)`, and intent-named `followup(...)`; provider resume dispatch remains private to its continuation manager. The standalone `@deepseek-ai/dsh-subagent-control` package and `ctx.subagentControl` key are absent; the optional `@deepseek-ai/dsh-tool-subagent-control` package injects `ctx.subagents` directly.

The merged service and its providers expose one `SubagentError` taxonomy. Stable codes distinguish provider lookup and capability failures from continuation routing, authorization, cancellation, persistence, and delivery failures; the removed service does not retain a separate error class.

The continuation implementation remains an internal manager rather than expanding the provider registry's core state. `SubagentRuntime` creates it through `ctx.inject(['tasks', 'agents'], ...)`, so the injected Cordis child fiber owns its Task completion listener and teardown effects. Loading the provider registry does not require Jobs or persistence. The manager exists only while Jobs and Agents are available, and each continuation operation resolves session persistence at the point it needs durability. Disposing that fiber cancels and settles active continuations before releasing their associations.

`startContinuable` remains distinct from raw `start` because it has a different ownership and timing contract: it allocates the durable child id, creates the Task, and returns both ids synchronously while startup continues inside the Task. Raw `start` instead awaits provider publication and transfers a holder-owned run. Folding the method onto `start` through flags or return unions would broaden the low-level contract and create more change than keeping the existing explicit entry.

Each `@deepseek-ai/dsh-tool-subagent` instance selects `backgroundMode: 'one-shot' | 'continuable'`, defaulting to `one-shot`. This configuration is policy; `provider.resume` is only the capability check for configured continuable mode. A resumable provider can therefore still run one-shot background work. The `send_message` tool is an independent adapter: loading or omitting it neither enables nor disables `startContinuable`.

## Alternatives considered

**Keep the separate service.** This preserves the strongest dependency separation, but every production continuable path composes both services and the extra public key exposes an architectural distinction callers do not need. The internal manager preserves optional Task and persistence dependencies without a second service.

**Infer continuable mode from `provider.resume`.** Method presence correctly states cold-resume capability but not deployment policy. It forced every resumable provider into continuable background semantics and made missing sibling plugins a runtime error. Explicit tool configuration separates choice from capability.

**Register continuation access or inspect the follow-up tool.** A registry could tell the delegation tool whether a continuation surface exists, but starting durable work does not require any follow-up adapter. Such a registry would encode UI composition into execution policy and recreate the sibling dependency under another name.

**Merge raw and continuable starts into one method.** A flag on `start` would return either a published one-shot run or immediate Task and child identities, weakening a simple ownership boundary. Keeping `startContinuable` is the smaller change and preserves both contracts explicitly.

## Consequences

- The service topology has one public key and one package fewer while raw provider dispatch remains usable without Jobs or persistence.
- Continuable mode fails at provider mount when the configured provider lacks `resume`; missing Jobs, Agents, or persistence still fail at the earliest operation that requires them.
- Follow-up delivery remains optional. Deployments may start and collect continuable work through Task tools without exposing `send_message`.
- The continuation manager is still Task- and persistence-aware inside the `dsh-subagent` package, so the package declares optional peer dependencies on those services even though ordinary `start` callers do not need them.
- Existing continuation races, authorization, durability, cancellation, and settle-then-dispose semantics are unchanged and remain pinned by the migrated `subagent` tests.
