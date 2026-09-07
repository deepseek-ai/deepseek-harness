# Agent Note: Product subagent named instances

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-18-product-subagent-named-instances.zh.md)

## Problem

A Profile can mount one Cordis plugin package in multiple rows, but the Codex and Claude Code product providers previously registered every row under one fixed product name. A second row therefore failed as a duplicate before its distinct model, permission mode, environment, or process-release settings could become usable. Deriving an implicit name from those settings would create a second identity rule, while choosing a provider during a tool call would let model input select deployment authority.

The existing subagent registry already owns unique provider names, reversible registration, lifecycle events, and holder-owned published runs. The existing `dsh-tool-subagent` configuration already binds one provider name to one model-visible tool name. Product providers need to expose the missing Profile-owned identity without adding another registry or selection protocol.

## Decision

Each product provider Config owns a non-empty `providerName`; the defaults remain `codex` and `claude-code`. The resolved name is fixed when the plugin row loads and becomes the Provider object's `name`; registration, lookup, lifecycle events, run logs, and HMR removal therefore use the same value. Each mounted row retains its own optional non-empty `model`, `permissionMode`, `env`, `disposeGraceMs`, and run resources. An explicit model is fixed for every query or thread from that instance, while omission leaves the native product settings authoritative.

Profiles may mount multiple Codex or Claude Code rows when every row uses a distinct `providerName`. Each `dsh-tool-subagent` row continues to bind its existing `provider` field to that exact name and exposes an independently configured `toolName`. Tool calls carry no provider selector, alias, or permission input. A duplicate provider name fails through the existing `DUPLICATE_PROVIDER` path and leaves the first registration intact.

Removing one provider row blocks new starts and removes only tools bound to that name. Runs already published by the removed instance remain owned by their holders and settle or dispose independently. Sibling instances remain registered and keep their own configured model, environment, native permission mode, cancellation controller, product process, and cleanup grace.

### Ownership and lifecycle

| Fact or operation | Owner | Result |
| --- | --- | --- |
| Provider instance name | Product Provider Config | One immutable registry name per mounted row, with the existing default when omitted |
| Name uniqueness and lifecycle events | `ctx.subagents` | Duplicate registration fails; disposal removes only the matching name |
| Model-visible tool name and binding | `dsh-tool-subagent` Config | One static tool resolves one configured provider name |
| Model, permission, environment, and process cleanup | One Provider instance | Concurrent runs and sibling instances do not share deployment configuration or run resources |

## Verification

Both product packages pin their default and custom names, empty-name and empty-model rejection, duplicate rollback, actual-name diagnostics, two concurrent instances with different models, permission modes, environments, and cleanup grace, cancellation isolation, and removal of one instance while its published run remains valid. Official product fixtures prove omitted-model inheritance and exact per-query or per-thread model isolation. Public Loader compositions mount two rows and two distinct tools for each product without starting either product, while keyless ACP snapshots pin the four-tool combined roster and the absence of dynamic provider or model parameters.

## Alternatives considered

**Derive names from the product or permission mode.** An implicit suffix would make identity change when deployment settings change and could still collide across equivalent rows. The Profile supplies the identity explicitly.

**Let a tool call choose the provider.** That would make model input select a permission and environment instance. Separate tool rows keep authorization and exposure static in configuration.

**Create a product-instance catalog or alias registry.** The existing subagent registry already owns names, uniqueness, lookup, events, and disposal. Another directory would duplicate state without a distinct consumer.

**Automatically rename duplicate rows.** Silent suffixing would make tool bindings and lifecycle diagnostics depend on load order. Duplicate names continue to fail loudly.

## Consequences

A Profile can expose several Codex and Claude Code tools backed by separate models, native permission modes, and environments while existing configurations continue to resolve `codex` and `claude-code`. Provider and tool names remain independent configuration facts, so changing one requires updating the binding that refers to it.

The design adds no runtime renaming, model-visible provider or model selector, generated tool name, persistent instance directory, shared process pool, model discovery, fallback, or compatibility alias. Correct multi-instance configurations require unique provider names and unique tool names; duplicate tool-name waiting remains a separate limitation.
