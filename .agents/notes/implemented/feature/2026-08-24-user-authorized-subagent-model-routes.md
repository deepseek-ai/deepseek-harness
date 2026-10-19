# Agent Note: User-authorized subagent model routes

Status: implemented

English | [中文](2026-08-24-user-authorized-subagent-model-routes.zh.md)

## Problem

Registering an LLM adapter makes its routes reachable, but does not authorize an Agent to choose every reachable model for a child. A single enabled preference over the live adapter registry expands silently when another provider or model appears. The product needs an explicit, stable authorization decision without rendering a potentially large model directory into every parent request.

## Decision

The Host-owned `subagent-model-selection` settings section stores an explicit `enabled` switch and `allowedModels`, an array of exact `{ provider, model }` routes. Enabling requires at least one route; disabling may retain the selected routes for later reuse. The Plugins settings card reads the live adapter directory through `session/modelCatalog`, lets the user stage the switch and routes, and saves both fields in one revision-fenced settings mutation. It stores no adapter-owned display names, descriptions, or reasoning-effort metadata. A stored or staged route absent from the current directory remains visible as unavailable and removable; a provider-local catalog failure does not block other providers or erase saved authorization or an unsaved selection. A connection reset discards the draft because namespace revisions are comparable only within one Host process.

The Host settings service snapshots the route list for each fresh top-level Session in `subagent/model-selection-policy` when the setting is enabled, before its first model request. Event presence means selection was enabled; the event does not store the global switch. Child Sessions inherit that exact list from their live parent, and resumed Sessions use the recorded event instead of current settings. Settings changes therefore affect only subsequently created top-level Sessions. Without the event, including an explicitly empty restored Session, explicit selection remains restricted to the current parent route.

The fixed `list_subagent_models` schema does not enumerate the policy. At call time, it lists authorized registered providers and intersects their advertised model catalogs with the recorded route list. Exact lookup requires authorization before resolving model metadata and all supported reasoning efforts, including for ids absent from the catalog. Without a recorded policy, discovery resolves only the parent Agent’s current effective route, even if the catalog omits it. The delegation executor independently checks any explicit provider, model, or effort selection against the same authorization before adapter preflight. A call with no selection fields retains configured or inherited routing.

Model selection has no unrestricted static mode. The default-off Host setting authorizes alternative child routes; without it, the parent route and its supported efforts remain selectable. Each delegation tool’s `modelSelection` option controls only its route fields. One delegation instance per scope enables `modelDiscovery` to own discovery; the setting, discovery, and delegation read the same package-local authorization projection. Web and Desktop presets mount discovery by default, enable spawn route fields, and leave fork route fields disabled to preserve inherited-prefix reuse; custom fork compositions may enable them under the same Session authorization. Tool installation does not sample or expand authorization.

## Alternatives considered

**Render the allowed routes in the delegation description.** Rejected because a large or changing list would enlarge every request and invalidate an early prompt prefix. On-demand discovery keeps the fixed schema prefix-stable and logs directory content only when requested.

**Filter only the settings UI or discovery result.** Rejected because a model can guess a route or retain one from an earlier transcript. Authorization is enforced in the executor that starts the child.

**Infer enablement from a non-empty `allowedModels` array.** Rejected because disabling would have to discard a useful selection or preserve a non-empty array whose meaning depends on write history. The explicit switch is authoritative, and the settings scope submits both fields in one Host-validated mutation so no intermediate state is persisted.

**Store per-route reasoning-effort allowlists.** Rejected because the user decision concerns child models, while effort ids and compatibility belong to the exact adapter route. Every adapter-supported effort remains available after the route is authorized.

**Read current settings on every discovery or delegation call.** Rejected because a settings edit would silently change a running Session's model-visible capabilities and execution authority. The durable Session snapshot keeps resume and child inheritance deterministic.

## Consequences

- New adapter registrations and newly advertised models do not expand user authorization.
- Adapter removal or catalog lookup failure can make provider discovery unavailable without deleting the saved route decision; an allowed model remains usable when its adapter accepts it even if the advisory catalog omits it.
- The allowlist itself consumes no parent-request tokens. Only a `list_subagent_models` result enters the transcript. The `modelSelection` option adds three route fields; `modelDiscovery` adds a fixed discovery schema. Both options default off; shipped headless and SDK profiles carry neither.
- The policy event is log-only and is appended while an Agent is composed, before either SDK begins its run subscription. Shipped SDK profiles do not enable this Web-owned preference, so the event changes neither SDK's expected notifications or persisted-session output; package restore tests own its durable projection instead of fabricating an SDK composition solely to emit it.
- Unit coverage pins settings validation, malformed durable values, Session sampling and inheritance, shared definitions, parent-route defaults, discovery restrictions, executor denial, and the settings UI’s staged writes and revision checks. The assembled Web scenario pins the real settings document and Plugins card flow.

## Related decisions

The route arguments, adapter preflight, discovery tool, and fork restriction remain owned by [model-selected subagent routes](../../../../packages/subagent/tool-subagent/README.md).
