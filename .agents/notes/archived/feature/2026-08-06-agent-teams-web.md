# Agent Note: Experimental Agent Teams Web controls

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-agent-teams-web.zh.md)

## Problem

The durable Agent Teams runtime owns roster, mailbox, and task state but exposes only model tools and Host service methods. Web users need to inspect teammate activity, manage shared tasks with the same compare-and-set rules, and open a teammate conversation. Agent Teams is still experimental, so these capabilities must not add Team-specific contracts or dependencies to the stable API Proxy, Session Controller, Client UI packages, or Web bundle.

## Decision

The private `ctx.agentTeams` service owns generated `agentTeams/view`, `agentTeams/createTask`, and `agentTeams/updateTask` Remote methods beside its domain operations. The Team package owns the browser-safe view and mutation-result types. Views contain roster and current task state but omit pending mailbox content and deleted task tombstones. Create and update rejections cross Remote as closed business results; stale update revisions preserve `team-task-conflict`, while other Team rejections preserve `team-rejected`. Unexpected failures remain ordinary `RemoteResult` failures.

`@deepseek-ai/dsh-experimental-client-ui-agent-team` mounts the `@deepseek-ai/dsh-experimental-agent-team/remote` contribution through the stable `ctx.remote` service, then consumes the generated `ctx.remote.agentTeams` methods without an additional Client result wrapper. It displays roster status, model and diagnostics and supports task create, edit, dependency update, assignment, completion, reopen, and deletion. Every update sends the displayed revision. Each create or update owns an independent pending token, invalidates older refreshes before starting, and reloads the complete Team view after success. A conflict asks the user to review only after its reload succeeds; a reload failure remains visible. Overlapping refreshes publish only the latest request for the selected Session.

Teammate navigation uses the existing `{ parentSessionId, childSessionId, mode: 'continuable' }` Subagent address without a Team tag. The UI refreshes the direct-child catalog, rechecks the selected Session, and opens the addressed conversation. History and later human prompts follow the stable Subagent path; the Team mailbox remains reserved for Team peer delivery from Team tools.

`@deepseek-ai/dsh-experimental-agent-team-web-profile` inserts only the UI after the stable Web bundle. It is applied alongside the Host-side `@deepseek-ai/dsh-experimental-agent-team-profile`, which already inserts `ctx.agentTeams` and the model tools. Neither stable bundle contains disabled Team rows or dependencies.

Stable Web presets still register continuable Subagent controls inside their preset scope. Top-level Agent Teams profile overrides cannot replace those registrations, so this experimental composition may expose both the Team roster and legacy child controls. A Team-aware Web preset is deferred; the [Web profile README](../../../../packages/experimental/agent-team-web-profile/README.md#known-limitations-and-deferred-work) owns the current limitation.

## Boundaries

The Web UI has no mailbox timeline, worktree or Git controls, teammate creation, rename, deletion, interruption, or automatic merge behavior. It does not infer filesystem authority from task ownership or write scopes. A human continuation after teammate navigation is an ordinary addressed-child prompt, not a Team mailbox message.

## Alternatives considered

**Extend the legacy API Proxy Team RPC map.** Rejected because it would put an experimental domain in a stable wire package and duplicate the generated Remote vocabulary and validation.

**Introduce a separate browser Remote service.** Rejected because the methods have no state, lifecycle, or policy owner distinct from `ctx.agentTeams`; a second Cordis service would duplicate Team injection and require another package for the same Typert namespace.

**Add Team metadata to the stable Subagent address and prompt routing.** Rejected because ordinary child navigation already identifies the conversation. A Team tag would couple stable Client and Subagent contracts to experimental mailbox policy.

**Put disabled Team rows in the stable Web bundle.** Rejected because a disabled row still creates release dependencies and makes the experimental package part of shipped composition.

## Testing

Team-service unit tests, generation, and a plain-Node built-artifact smoke verify the direct Remote methods, error mapping, and exported descriptors. Client typechecking and browser component tests cover the mounted namespace, Lead routing, raw generated results, every task action, independent pending operations, complete-board reloads, successful and failed conflict reloads, stale async results, navigation, disposal, and status or error presentation. A Web end-to-end test asserts that its overlay equals both shipped experimental profile layers, then exercises the real Host Remote flow.

## Consequences

The Team service is the single Cordis owner for both domain state and the Remote operations that expose selected Team values. The stable API Proxy, Session Controller, Client UI packages, and Web bundle remain Team-agnostic. Source-checkout users must add two ordered experimental profile layers to a Web profile. Promotion renames the experimental npm packages but does not require a new generated namespace.
