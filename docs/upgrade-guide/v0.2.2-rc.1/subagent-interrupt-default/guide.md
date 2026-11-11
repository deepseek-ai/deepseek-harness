---
kind: upgrade-guide
description: "Built-in configurations disable interrupt_agent for subagents and Team mode."
---

# Built-in configurations disable agent interruption

English | [中文](guide.zh.md)

## Change

The base bundle and the Web `standard`, `cordis`, and `ptc` presets now set `config.interrupt: false` on their `tool-subagent-control` rows. Models using these configurations no longer receive `interrupt_agent`, including in Team mode. Messaging, discovery, inbox waiting, and the subagent service interruption API remain available. The plugin's own default remains `true`; independent compositions that omit the setting retain interruption.

## Migration

Keep `interrupt: false` to retain the built-in behavior. To restore interruption:

1. Edit `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. For base-backed profiles such as `headless`, `sdk`, and `acp`, append:

   ```yaml
   - id: tool-subagent-control
     config:
       interrupt: true
   ```

2. For `web` or `desktop`, instead override each required declaration: `preset-standard`, `preset-cordis`, or `preset-ptc`. Copy that declaration's complete `config` from the installed `@deepseek-ai/dsh-web-app` bundle's `presets/<name>.patch.yml` (source: [standard](../../../../packages/bundle/web-app/presets/standard.patch.yml), [cordis](../../../../packages/bundle/web-app/presets/cordis.patch.yml), [ptc](../../../../packages/bundle/web-app/presets/ptc.patch.yml)). If your profile already overrides the declaration, edit that override to preserve your customizations. A patch replaces the whole `config`: retain `id`, `order`, and the entire `plugins` list, including the `delegation` group. Within that group's `config`, change the `tool-subagent-control` row's `config.interrupt` to `true`. Use the declaration's outer ID as the patch target, following [Change a shipped preset](../../../../packages/preset/agent-preset/skills/dsh-doc/references/compositions.md#change-a-shipped-preset). A top-level patch targeting `tool-subagent-control` does not reach the preset's child row; it only changes the disabled Host row. Leave that Host row disabled.
3. Restart the profile and create a new Session using the changed preset; existing Sessions retain their preset revision. Confirm that the model's tool definitions include `interrupt_agent`, `send_message`, `list_agents`, and `wait_agent`.
