---
kind: upgrade-guide
description: "Custom headless profiles need the agent preset registry to resume a Session by ID."
---

# Resuming a Session from a custom headless profile

English | [中文](guide.zh.md)

## Change

`--session-id` now reads the saved agent preset through the `agentPresets` service. A custom profile that mounts the headless runner directly previously needed only Session persistence and query services for this check. The shipped `dsh-headless` bundle enables the registry and preserves any configured default.

## Migration

1. If your custom profile mounts the runner directly on `dsh-base`, enable the existing registry row in the profile’s `cordis.patch.yml`.

   ```yaml
   - id: agent-preset-registry
     disabled: false
   ```

2. If your profile supplies its own base, add `@deepseek-ai/dsh-agent-preset-registry` to its dependencies and insert a row with that plugin name. The registry can read saved selections without a configured default.
3. From the original working directory, run `dsh --profile <profile> --session-id <id> "continue"` with an existing headless Session ID. The runner should resume that Session.
