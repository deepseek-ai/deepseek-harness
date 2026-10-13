---
kind: upgrade-guide
description: "Subagent persona and toolFilter configuration is replaced by Agent Preset composition."
---

# Configure subagent composition through presets

English | [中文](guide.zh.md)

## Change

`dsh-tool-subagent` rejects `persona` and `toolFilter` configuration. New `SubagentStartRequest` values and provider capabilities no longer expose either field. In-process spawn selects a preset through `agentPreset`; its persona and tools come from that preset's plugins. Fork inherits the parent's preset and cannot independently change persona or restrict tools. Model and reasoning-effort options are unchanged.

The shipped `standard`, `ptc`, and `cordis` delegation tools no longer hide `schedule_*` tools. Delegated callers still receive the existing execution refusal. Historical child Session descriptors retain their persona and tool restrictions when resumed.

## Migration

1. Remove `persona` and `toolFilter` from `dsh-tool-subagent` rows in your profile patches and custom presets. Update programmatic callers and provider capability declarations to remove the same fields.
2. For spawn, define an Agent Preset containing `dsh-persona` and the required tool plugins, then set the delegation tool's `agentPreset` to its id. Use `allowedAgentPresets` to offer several declared presets to the parent model. Presets select plugin compositions; there is no replacement per-child tool-name filter.
3. For fork, remove the overrides and accept the inherited composition. If the task needs a different composition, use spawn with a preset; it does not inherit the parent's conversation.
4. Start a new Session and delegate a task. Confirm that the child uses the selected preset's persona and tools. Existing persisted child Sessions need no manual edits.
