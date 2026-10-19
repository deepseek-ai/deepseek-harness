---
kind: upgrade-guide
description: "The maxBytes budget of @deepseek-ai/dsh-agent-instructions caps each instruction chain separately, so a baseline holding both chains can reach twice the configured size."
---

# Size `maxBytes` of `@deepseek-ai/dsh-agent-instructions` per instruction chain

English | [中文](guide.zh.md)

## Change

`maxBytes` of `@deepseek-ai/dsh-agent-instructions` bounded the complete workspace-instruction baseline and each reconciliation message. It now bounds the user-global chain (`$DSH_HOME/AGENTS.md` and the shared agents root) and the project chain separately, so a message holding both chains can reach twice the configured size. The exported `loadBaselineInstructions` and `renderAgentInstructions` follow the same bound. Deployments that sized `maxBytes` as a total prompt budget observe the larger maximum.

## Migration

1. When the old total must hold, halve `maxBytes` in the `@deepseek-ai/dsh-agent-instructions` row of the deployment's `cordis.yml` or patch; `dsh-base` keeps `65536`. `maxBytes` is part of the baseline identity, so every session resumed after the change receives one complete replacement baseline.

   ```yaml
   - name: '@deepseek-ai/dsh-agent-instructions'
     config:
       maxBytes: 32768
   ```

2. Start a new session and read the first `user/message` whose `source.kind` is `agent-instructions` in its session log: its text stays within twice `maxBytes`, and a `Workspace instruction budget ...` line names every omitted or truncated file.
