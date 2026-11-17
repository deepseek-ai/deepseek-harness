---
kind: upgrade-guide
description: "Subagent model selection reads the current Host setting at each call instead of a policy recorded in each Session."
---

# Read subagent model selection from the current setting

English | [中文](guide.zh.md)

## Change

The Host `@deepseek-ai/dsh-tool-subagent/model-selection-settings` service no longer appends `subagent/model-selection-policy` when an Agent is created. `subagent` and `list_subagent_models` read `ctx.subagentModelSelection.allowedRoutes()` at each call, so a settings edit applies to the next call in every running, restored, and child Session. When the setting is disabled or the service is not mounted, explicit selection permits only the current parent route. Sessions that recorded a policy in an earlier release ignore it and follow the current setting.

An enabled setting with an empty or repeated route list no longer rejects Agent creation; each delegation or discovery call that reads it fails instead. The service no longer injects `sessions` or `sessionProjections`, and `@deepseek-ai/dsh-tool-subagent` no longer injects `sessionProjections`. The `subagentModelSelectionProjectionDefinition`, `subagentModelSelectionPolicy`, and `SubagentModelSelectionSettings` exports are removed.

## Migration

1. Replace reads of the `subagentModelSelectionPolicy` projection or `subagent/model-selection-policy` events with `ctx.subagentModelSelection.allowedRoutes()`; it returns the authorized routes, or `undefined` when selection is disabled.
2. If an existing Session must keep its earlier allowlist, set that list in the `subagent-model-selection-settings` namespace; the recorded event no longer applies.
3. Confirm the change: in an open Session, enable the setting with one route, then call `list_subagent_models` without arguments and verify that it lists that route's provider. Disable the setting and verify that an explicit delegation to that route fails with `MODEL_ROUTE_NOT_ALLOWED`.
