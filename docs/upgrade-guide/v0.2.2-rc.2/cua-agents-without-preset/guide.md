---
kind: upgrade-guide
description: "A native CUA provider configured with a preset id now gives Agents without an Agent preset the cua_run_code tool."
---

# CUA gives Agents without a preset `cua_run_code`

English | [中文](guide.zh.md)

## Change

A native CUA provider whose `agentPreset` is a preset id, including the default `ptc`, registered no tool for an Agent that had joined no Agent preset, and nothing at all in a composition without the preset registry. Such an Agent now receives `cua_run_code` and its operation guidance. Agents on the configured preset still receive raw `cua`, Agents on other presets still receive `cua_run_code`, and `agentPreset: false` still registers raw `cua` globally.

Hosts that create Agents without a preset are affected: the `sdk`, `sdk-minimal`, `headless`, and `acp` profiles and custom compositions. Web and Desktop sessions join a preset and do not change. An affected composition that mounts the provider with a preset id, directly or through the Computer Use bundle, observes:

- The model request gains the `cua_run_code` schema and the CUA guidance.
- Agent creation waits for the provider's dedicated program runtime; it rejects while that runtime or the `workingDirectory` service is unavailable, for example with `CUA program tool is unavailable`.
- With `@deepseek-ai/dsh-tool-executor-ptc` mounted on the Host, programs see `tools.cua_run_code` inside `run_code`.

## Migration

1. To keep raw `cua`, called directly or as `tools.cua` under the PTC tool executor, set `agentPreset: false` under the provider entry's `config` in the profile patch or overlay. Preserve its other fields.
2. To keep Computer Use away from these Agents, disable the provider entry or deselect the Computer Use bundle for that profile.
3. Start a session and confirm the model's tool list: `cua_run_code` by default, `cua` after step 1, and neither after step 2.
