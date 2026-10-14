# Agent Note: Preset-owned subagent composition

Status: implemented

English | [中文](2026-10-09-preset-owned-subagent-composition.zh.md)

## Problem

Agent Presets already compose persona and tool plugins. Independent child persona and tool-filter inputs create a second place to configure that composition. The shipped consumers of child filtering are the six schedule deny lists in the spawn and fork rows of the standard, PTC, and Cordis presets; reminder executors already refuse delegated callers.

## Decision

New subagent requests select an Agent Preset where the provider supports it. Persona and tools come from its plugin list. Fork inherits the parent's preset revision; model and effort selection keep their existing configuration. No preset-level filter or finer plugin split is added without a concrete consumer.

`dsh-tool-subagent` rejects removed `persona` and `toolFilter` keys at load, including empty values, because deleting Schemastery fields alone does not reject unknown configuration. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.md) states the lost independent override capability and the migration.

Released child descriptors keep their persona and filter fields, parsing, and cold-resume application. The [original composition note](../feature/2026-07-12-subagent-persona-tool-filter-and-depth.md) remains active for these historical semantics and the independent depth policy. The [spawn preset decision](../feature/2026-09-20-spawn-agent-preset-selection.md) continues to own selection and restoration identity.

The shipped child schedule deny lists are absent. Reminder schemas remain visible when inherited from the preset; each executor rejects delegated callers. This avoids that source of parent/fork schema differences. Children receive four reminder schemas whose executors always refuse them. Neither their prompt cost nor a provider cache-hit improvement has been measured; other request inputs can still differ.

## Alternatives considered

**Move the filter into each preset.** This preserves the schedule deny lists and independent fork tool trimming, but retains two configuration mechanisms for tool availability. New children use plugin composition; fork deliberately inherits the parent's tools.

**Keep per-request overrides alongside presets.** This retains independent fork overrides, their precedence rules, and provider capability flags. A single composition mechanism is preferred over that flexibility for new children.

**Delete historical descriptor fields with the request fields.** This would change or reject restored sessions. New-request simplification does not authorize rewriting released Session data.

## Consequences

Preset selection owns new child persona and tools. Fork cannot independently replace persona or trim inherited tools, and JavaScript configuration with the removed keys fails explicitly. Historical restoration retains its previous semantics. Focused tests cover removed-key diagnostics, historical persona/filter restoration, inherited reminder schemas and executor refusal; recorded sessions cover preset-owned tool availability, fork reminder refusals, and messaging guidance.
