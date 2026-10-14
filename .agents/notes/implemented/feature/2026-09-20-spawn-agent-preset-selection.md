# Agent Note: Independent spawn preset selection and restoration

Status: implemented

English | [中文](2026-09-20-spawn-agent-preset-selection.zh.md)

## Problem

Spawned agents need reusable combinations of persona, tools, and skills without replacing the [implicit parent-preset join](../../archived/bug-fix/2026-08-10-child-agents-join-their-parent-preset.md). Restoration must distinguish an independent selection from historical child logs without changing the Session format or fork behavior.

## Decision

An explicit spawn preset id resolves the currently registered definition, even when it equals the parent's id. Omission joins the parent's exact live revision. Selecting a named configuration accepts its current declaration and resolution failures; inheriting an active composition preserves its plugin instances even after that declaration changes or is removed.

An independently selected child records the existing `agent-preset/selected` event before its first own `subagent/descriptor`. Cold restoration excludes the inherited fork prefix and uses that ordering to identify independent selection, then reads the selected id from the existing `agentPreset` projection. A missing projection rejects restoration rather than silently switching to the parent's composition.

Historical children without this ordering retain the implicit join. A creation header can contain an inherited preset id, while a fork's seed can contain an ancestor's selection and an old child can record a selection after its descriptor. None of these facts establishes independent selection at child creation. The ordering marker preserves those histories without adding a descriptor field or another event type.

## Alternatives considered

**Resolve every child by preset id.** This would make an omitted selection observe an updated definition or fail after its removal, changing the implicit join and historical restoration behavior.

**Infer independent selection from the header or projection alone.** Both can carry inherited values. A last-value projection also loses the ordering needed to distinguish a creation-time selection from later selections in historical logs.

**Store a preset id in a new descriptor version.** The existing selection event and projection already persist the id. Another field would duplicate it and require a descriptor migration for a distinction the existing event order can express.

**Support a nested preset object.** A second configuration spelling adds precedence and validation rules without serving an existing caller. A flat preset id selects composition; fork does not accept independent preset selection.

## Consequences

Independent restoration resolves the selected id against the registered definition; it does not preserve a historical revision across restarts. Missing or invalid presets fail explicitly. Implicit children and fork retain their existing composition and cold-restoration behavior.

Focused continuation tests cover event ordering, inherited prefixes, historical logs, and missing projections. The recorded-session preset scenario covers independent persona and tool selection through the shipped headless composition.
