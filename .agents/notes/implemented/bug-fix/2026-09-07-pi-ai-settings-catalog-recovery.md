# Agent Note: Repairable pi-ai settings after catalog changes

Status: implemented

English | [中文](2026-09-07-pi-ai-settings-catalog-recovery.zh.md)

## Problem

An installed pi-ai catalog can change the validity of unchanged user settings. OpenRouter models outside the catalog can inherit a protocol while all shipped models agree; adding a second protocol removes that inference. Removing a catalog model also invalidates an override keyed by its former id. Rejecting the entire settings namespace at registration makes unrelated providers disappear and removes the controls needed to repair the configuration.

## Decision

The pi-ai consumer uses the existing settings `validate` callback. During namespace registration it tolerates catalog diagnostics; after registration it strictly checks changed providers against the current resolved section. Settings invokes this callback before persistence for update, replacement, and path mutation. External reload uses the same strict check and retains the last accepted section on failure. The settings service and its public API remain unchanged.

Initial profile resolution retains catalog diagnostics, while schema and self-contained profile constraints still reject loading. Writes strictly resolve each new or changed provider, comparing effective provider values against the committed snapshot. Unchanged failed providers do not block another provider's edit, and deletion remains possible. Editing a provider-wide setting validates all models it affects.

Profile resolution keeps valid models beside per-model errors. A missing override retains its diagnostic without disabling the remaining catalog. A route-level catalog failure retains its provider and editable settings but supplies no callable models. When route-wide validation aborts catalog resolution, the incomplete catalog and its collected per-model diagnostics are discarded; model requests on that route report the route-level error. The adapter checks the selected model's recorded failure before credentials or network I/O and reports `INVALID_CONFIG`. No protocol is guessed and no user configuration is rewritten during loading. Immutable snapshots still keep an in-flight request on its captured configuration.

`LlmConfigurableProvider.error` carries the first available model diagnostic for the provider row, falling back to the route error. A provider-construction failure does not overwrite a collected model diagnostic, preserving the specific correction for a missing protocol. The configurable-provider directory publishes diagnostic changes so configuration repair refreshes the browser without re-registering the adapter. Failed model ids remain in settings, while the model selector receives serviceable entries. Models settings displays the diagnostic and retains edit/delete controls. Both add actions require their owning settings namespace; the ordinary add menu filters out unavailable namespaces.

This extends the [provider-routed adapter decision](../architecture/2026-07-14-provider-routed-llm-adapters.md): provider ownership and request snapshots remain unchanged, while catalog validity does not determine whether settings can be managed. That note remains active for routing, ownership, and replay rationale.

## Alternatives considered

**Reject catalog errors at registration.** This prevents users from repairing an otherwise parseable configuration and lets an unused stale model disable unrelated providers.

**Relax save validation too.** A newly entered model with no inferable protocol can be rejected immediately with the offending provider and model named. Accepting it creates an avoidable request-time failure.

**Strictly revalidate the entire namespace on every save.** An unrelated provider's old error would block adding a healthy provider or repairing providers independently.

**Assign OpenRouter a fixed route protocol.** A route override replaces every model's protocol and can change working catalog entries that intentionally use another API.

## Consequences

Upgrade-dependent errors remain visible and repairable without weakening validation of new provider edits. Configuration errors remain distinct from remote model existence: a catalog-external id with an explicit protocol is accepted, and its endpoint decides whether that id exists. Scalar or document errors still fail early. Models settings does not explain namespace registration failures; those errors require inspecting the configuration and startup diagnostics. No settings API, storage format, or session event is added; configurable-provider entries gain one optional diagnostic field.

## Testing

Adapter tests cover mixed valid/invalid models, deleted override referents, independent provider edits, route deletion, pre-network failure, and repair. A file-watcher regression verifies that invalid external edits retain the last accepted profiles and a repaired file takes effect. The assembled Web expectation boots with stale OpenRouter settings, preserves zai and both add controls, rejects an invalid save without changing the file, and repairs the route by removing the stale model. Existing snapshot tests continue to own request freezing and replay behavior.
