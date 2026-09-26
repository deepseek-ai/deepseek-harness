# Agent Note: Retire the prompt registry change event

Status: proposed

English | [中文](2026-09-19-retire-prompt-registry-change-event.zh.md)

## Problem

[`SystemPrompt`](../../../../packages/core/system-prompt/src/index.ts) emits `system-prompt/change` when providers register or dispose. Repository searches find no executing product listener, but generated Host discovery advertises the event. Tests maintain notification counts and rollback after listener exceptions. This is a public extension with maintenance obligations, even without a first-party subscriber.

The active [Remote event delivery decision](../../implemented/architecture/2026-08-10-remote-event-delivery.md) explicitly retains this extension despite having no shipped consumer. Per-step assembly predates that promise and serves a different purpose: rebuilding model input does not replace push observation of registry changes.

## Proposal

Retire `system-prompt/change` and accept the loss of prompt-registry push observation for installed and dynamically authored Host plugins. Remove its declaration, emitter, current documentation, generated discovery entries, and notification-specific tests. No currently supported product path requires this extension.

Make [`ScopedLayers`](../../../../packages/core/scope/src/store.ts)'s constructor notification callback optional and omit it for `SystemPrompt`; do not supply a no-op callback. Remove the existing no-op arguments in [jobs-local](../../../../packages/jobs/jobs-local/src/index.ts) and [mcp-resources](../../../../packages/mcp/mcp-resources/src/index.ts) when updating this shared constructor, and update jobs-local's adjacent notification explanation. Preserve shared effects, action rollback, undo ordering, layer reclamation, and `tools/change` with its production consumers. Keep prompt-provider evaluation, scope shadowing, and assembly invariants.

Implementation must amend the active Remote event delivery note to state that this proposal supersedes only its promise to retain `system-prompt/change`. Remove that event from the retained-extension statement and link the implemented retirement decision. Keep the Remote delivery note active and cross-linked: its forwarding policy and other extensions remain independently useful. Do not rewrite or archive that entire decision.

## Alternatives considered

**Keep the extension for future dashboards or plugins.** Push observation could support a real consumer, but none is identified in supported product paths. Retention preserves notification and listener-failure behavior that the package otherwise does not need.

**Treat per-step assembly as proof of compatibility.** Rejected because model-input reconstruction and registry notifications are different behaviors. This proposal deliberately changes the extension promise rather than claiming the earlier reconstruction decision already removed it.

## Acceptance criteria

- Remove the event from source and current generated inventories, and amend the active retention promise in the implementation change.
- Remove notification-count and notification-failure tests; retain provider-membership, disposer, duplicate-registration, shadowing, and HMR coverage. Keep mixed tests' independent assertions.
- Run focused scope, tools, system-prompt, jobs-local, and mcp-resources tests, loop request-reconstruction coverage, a relevant keyless recording, catalog generation, typecheck, lint, and doc-sync. Prompt/log output remains unchanged.

## Risks

Installed plugins may depend on notifications or on listener exceptions rejecting registration. They lose both behaviors; repository searches cannot establish their absence. A future push consumer needs an explicit registration-observation requirement and ownership design before reintroducing an event. Source savings are small; the benefit is retiring the public notification and failure obligation.
