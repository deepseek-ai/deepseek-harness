---
kind: upgrade-guide
description: "Claude Code and Codex bundles add global delegation tools while retaining their package and row identities."
---

# Native subagent bundles include global tools

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-subagent-claude-code` and `@deepseek-ai/dsh-subagent-codex` keep their package names, bundle selections, provider row IDs, configuration, and native authentication. A selected bundle now also registers its delegation tool as a Host global tool, visible to every preset including minimal; previously the bundle registered only its provider. Live Agents see the tool from their next request after the bundle is enabled, and lose it after the bundle is switched off.

The contributed Host rows are `tool-subagent-claude-code` and `tool-subagent-codex`. Later user layers can override their configuration or disabled state by row id. An override does not select an unselected bundle. A preset that registers its own tool with the same name shadows the global tool for its Agents.

Delegation follows the shared managed-activation API: the tool returns a child ID, and completion arrives as a logged notice to the parent Agent. Remove obsolete `backgroundMode` settings; `maxDepth: provider-managed` remains supported for these native providers.

## Migration

1. Preserve selected bundle names, provider configuration, and authentication. Existing provider-only packages need **Update** in Plugins → Official to receive the tool-contributing bundle; restart when requested. To adopt a new provider, enable its card. [Installation targets](../../../../packages/boot/plugin-manager/README.md#use-this-package) follow the published DSH version or source checkout; equal version strings do not make an older registry package equivalent to a development link. Off only deselects; Remove remains separate.
2. Configure the tool with an ordinary row patch. Configuration overrides still replace the complete configuration. For example, this keeps the Codex tool disabled while the provider stays registered:

   ```yaml
   - id: tool-subagent-codex
     disabled: true
   ```

3. If a manual Host row registers the same tool name, remove that redundant row or disable the bundle's row. Verify the effective tool catalog in a Session.
4. Plugin clients receive required `BundleInfo.official` and `BundleInfo.availability` fields; detail-slot `PluginPackageRef` receives them too. `official` identifies project maintenance, `availability` reports `installation`, `profile`, or `missing`, and `installed` still means a profile dependency declaration. Detail-slot readers that only display existing fields need no changes; constructors and exact validators must include the new fields. Optional `installTarget` identifies the offered version and registry or local-link spec.

**Other profiles.** The bundle layers insert Host rows only, so headless, SDK, ACP, and custom profiles can select them as well. Profiles that keep the provider package without selecting its bundle can compose the same rows using the [Codex](../../../../packages/subagent/subagent-codex/README.md#exposing-the-tool) or [Claude Code](../../../../packages/subagent/subagent-claude-code/README.md#exposing-the-tool) example.
