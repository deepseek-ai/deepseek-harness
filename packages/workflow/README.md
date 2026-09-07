---
description: "The workflow group map: model-authored orchestration scripts that fan out subagents, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/workflow

English | [中文](README.zh.md)

## Summary

The workflow group lets an agent run a model-authored orchestration script that fans work out across many subagents and returns a final value. The `workflow` package provides the run service, the worker-thread package executes scripts in isolated threads, and two model-facing tools expose orchestration: the general `workflow` tool for scripted fan-out and the fixed `ralph` tool for fresh-agent iterative loops. The script coordinates agents with hooks while the agents do the actual work. The engine keeps a script's synchronous work off the host event loop but is containment, not a security boundary.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`workflow`](workflow/README.md) | Runs a model-written orchestration script that fans out subagents | `ctx.workflowEngine` |
| [`workflow-worker-thread`](workflow-worker-thread/README.md) | Executes each workflow script in its own worker thread, off the host event loop | registers on `ctx.workflowEngine` |
| [`tool-workflow`](tool-workflow/README.md) | Gives the model the `workflow` tool for scripted multi-agent orchestration | registers on `ctx.tools` |
| [`tool-ralph`](tool-ralph/README.md) | Gives the model the `ralph` tool for fresh-agent iterative loops | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Workflow subsystem](../../docs/subsystems/workflow.md) — the seam's types, start request, and `workflow/*` events.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-workflow) — the `workflow` tool schema the model receives.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-ralph) — the `ralph` tool schema the model receives.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-workflow-worker-thread) — every accepted engine config field.
- [Dynamic workflows Agent Note](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md) — the seam design and its decisions.
- [Harness-level goal-based execution Agent Note](../../.agents/notes/implemented/feature/2026-07-16-harness-level-loop.md) — the fixed fresh-agent loop design and deferred work.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
