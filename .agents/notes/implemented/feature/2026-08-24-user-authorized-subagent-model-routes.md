# Agent Note: User-authorized subagent model routes

Status: implemented

English | [中文](2026-08-24-user-authorized-subagent-model-routes.zh.md)

## Problem

Registering an LLM adapter makes its routes reachable, but does not authorize an Agent to choose every reachable model for a child. A single enabled preference over the live adapter registry expands silently when another provider or model appears. The product needs an explicit, stable authorization decision without rendering a potentially large model directory into every parent request.

## Decision

The Host-owned `subagent-model-selection` settings section stores an explicit `enabled` switch and `allowedModels`, an array of exact `{ provider, model }` routes. Enabling requires at least one route; disabling may retain the selected routes for later reuse. The Plugins settings card reads the live adapter directory through `session/modelCatalog`, lets the user stage the switch and routes, and saves both fields in one revision-fenced settings mutation. It stores no adapter-owned display names, descriptions, or reasoning-effort metadata. A stored or staged route absent from the current directory remains visible as unavailable and removable; a provider-local catalog failure does not block other providers or erase saved authorization or an unsaved selection. A connection reset discards the draft because namespace revisions are comparable only within one Host process.

A newly composed top-level Session snapshots the route list in `subagent/model-selection-policy` when the setting is enabled, before its model-selectable definitions can reach a request. Event presence means selection was enabled; the event does not store the global switch. Child Sessions inherit that exact list from their live parent, and resumed Sessions use the recorded event instead of current settings. Settings changes therefore affect only subsequently composed top-level Sessions, while a legacy Session without the event remains disabled, including an explicitly empty restored Session.

The fixed `list_subagent_models` schema does not enumerate the policy. At call time, provider and model listings are the intersection of the Session route list and the adapter's live advertised directory. An exact provider/model lookup first requires authorization, then resolves the adapter-owned model metadata and all advertised reasoning efforts. The delegation executor independently rejects any explicit provider, model, or effort selection whose effective provider/model route is outside the Session list before `resolveCallConfig()` validates adapter availability and effort support. A call that supplies no selection field retains configured or inherited routing because the model made no route choice.

Model selection has no unrestricted static mode. The default-off Host setting is the only authority, and an enabled Session always carries an exact allowlist. The primary spawn tool reads that setting; the shipped fork tool still exposes no route selection so inherited conversation prefixes remain eligible for provider-side KV Cache reuse.

## Alternatives considered

**Render the allowed routes in the delegation description.** Rejected because a large or changing list would enlarge every request and invalidate an early prompt prefix. On-demand discovery keeps the fixed schema prefix-stable and logs directory content only when requested.

**Filter only the settings UI or discovery result.** Rejected because a model can guess a route or retain one from an earlier transcript. Authorization is enforced in the executor that starts the child.

**Infer enablement from a non-empty `allowedModels` array.** Rejected because disabling would have to discard a useful selection or preserve a non-empty array whose meaning depends on write history. The explicit switch is authoritative, and the settings scope submits both fields in one Host-validated mutation so no intermediate state is persisted.

**Store per-route reasoning-effort allowlists.** Rejected because the user decision concerns child models, while effort ids and compatibility belong to the exact adapter route. Every adapter-supported effort remains available after the route is authorized.

**Read current settings on every discovery or delegation call.** Rejected because a settings edit would silently change a running Session's model-visible capabilities and execution authority. The durable Session snapshot keeps resume and child inheritance deterministic.

## Consequences

- New adapter registrations and newly advertised models do not expand user authorization.
- Adapter removals or catalog failures can reduce what discovery currently lists without deleting the saved route decision; an exact authorized route remains usable when its adapter accepts it even if the advisory catalog omits it.
- The allowlist itself consumes no parent-request tokens. Only a `list_subagent_models` result enters the transcript.
- The policy event is log-only and is appended while an Agent is composed, before either SDK begins its run subscription. Shipped SDK profiles do not enable this Web-owned preference, so the event changes neither SDK's expected notifications or persisted-session output; package restore tests own its durable projection instead of fabricating an SDK composition solely to emit it.
- Unit coverage pins settings validation, malformed durable values, Session sampling and inheritance, discovery intersection, executor denial, live UI catalog invalidation, staged-route retention, connection-generation invalidation, staged whole-array writes, stale-revision rejection, and retry after scoped installation failure. The assembled Web scenario pins the real settings document and Plugins card flow.

## Related decisions

The route arguments, adapter preflight, discovery tool, and fork cache restriction remain owned by [model-selected subagent routes](2026-08-18-model-selected-subagent-routes.md).
