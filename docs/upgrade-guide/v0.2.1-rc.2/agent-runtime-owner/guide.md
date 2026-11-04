---
kind: upgrade-guide
description: "Agent creation and resume options rename parentAgent to ownerAgent for runtime ownership."
---

# Agent runtime ownership uses `ownerAgent`

English | [中文](guide.zh.md)

## Change

`CreateAgentOptions` and `ResumeAgentOptions` in `@deepseek-ai/dsh-agent` replace `parentAgent` with `ownerAgent`. This affects plugins and custom factories calling `ctx.agents.create()` or `ctx.agents.resume()`. The field selects the live Agent that owns the runtime instance; omitting it creates a runtime root.

Session creation lineage remains in `meta.parentSession`. For a nested subagent, the runtime owner can be the tree root while the direct creator is another descendant. Persisted Session fields and formats are unchanged.

## Migration

1. Rename the `parentAgent` option to `ownerAgent` in creation and resume calls, and update custom `AgentFactory` implementations that read or forward it. Pass the same Agent as before.
2. Keep `meta.parentSession` and stored `parentSession` values unchanged. Do not substitute the runtime owner for the direct creator.
3. Typecheck consumers against the updated package, then verify that `ctx.agents.isOwnedBy(id, owner)` and `ctx.agents.roots()` report the same runtime relationships after creation and resume.
