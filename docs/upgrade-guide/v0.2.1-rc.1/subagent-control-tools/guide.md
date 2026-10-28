---
kind: upgrade-guide
description: Custom subagent compositions must update model-selection settings and register discovery through main entries.
---

# Update subagent model selection and control tools

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-tool-subagent` replaces `modelSelectionSettings` with `modelSelection`, which controls optional child route fields. Discovery requires `modelDiscovery: true` on one instance per tool scope. Both options default to false. The package has no `/list-models` plugin export. Shipped Web and Desktop presets enable both options on spawn and keep fork route fields disabled; custom fork tools may enable selection. Headless, SDK, and ACP defaults retain their tool sets.

The Host `/model-selection-settings` service records authorization during Agent creation, including Sessions created before delegation tools are mounted. Child Sessions inherit the policy, restored Sessions preserve it, and later tool installation or settings edits do not resample existing Sessions. Without a recorded policy, discovery and explicit selection permit only the current parent route. Enabling the Host setting with an empty allowed-model list rejects every fresh top-level Session, even without delegation tools; the settings UI prevents saving that combination.

`@deepseek-ai/dsh-tool-subagent-control` registers `send_message`, `interrupt_agent`, and `list_agents` together and requires `tools`, `subagents`, and `agents`. Its separate `/list-agents` export is removed. Model discovery follows its configured delegation-tool instance’s lifetime, independently of the delegation provider; unloading that instance removes discovery even if other instances remain. Discovery calls fail if `llm` is unavailable.

## Migration

1. In custom `cordis.yml`, patches, or direct plugin configuration, rename `modelSelectionSettings: true` to `modelSelection: true`. Set `modelDiscovery: true` on one delegation instance per tool scope that needs `list_subagent_models`; multiple discovery owners in one scope fail registration.
2. Mount `@deepseek-ai/dsh-tool-subagent/model-selection-settings` in the Host before creating Agents when custom compositions need user-authorized alternative routes. Supply its required `sessions` and `sessionProjections` services. If its setting is enabled, supply a non-empty allowed-model list. Direct `apply(ctx, config)` callers no longer pass a Session argument.
3. Replace `/list-agents` rows with one `@deepseek-ai/dsh-tool-subagent-control` row per tool scope, or remove them if that row already exists. Remove patches targeting the retired `tool-subagent-list-agents` row. Disabling the shared control row now disables all three tools; use tool restrictions to hide individual tools.
4. Create a fresh Session and verify one definition of each requested tool. Discovery must return authorized routes when the preference is enabled, or only the parent route otherwise; explicit unauthorized delegation must fail. Unload the discovery-owning instance and verify that its discovery tool disappears.
