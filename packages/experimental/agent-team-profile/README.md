---
description: "Published experimental Agent Teams profile layer over dsh-base with teammate delegation and fresh workflow children."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-team-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-team-profile` is a published experimental profile layer that enables [Agent Teams](../agent-team/README.md) over `@deepseek-ai/dsh-base`. Its patch inserts the Team domain and Team-scoped tools and disables ordinary subagent delegation and the overlapping global continuable-child controls. Workflow remains available with fresh children. Add it explicitly to an initialized profile; no shipped profile enables it by default.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

Add the package to an initialized profile, then run a task that asks the Lead to delegate work:

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile
dsh --profile headless "Use Agent Teams to split this task between two teammates, wait, and summarize."
```

The profile must already contain `@deepseek-ai/dsh-base`, whose Subagent services and provider rows this layer consumes. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-agent-team-profile` removes the bundle from the profile's ordered layer list.

### What you get

The layer adds the Agent Teams domain and its scoped creation, roster, messaging, interruption, waiting, and task-board tools. Direct delegation uses `spawn_teammate`, which supports fresh and fork context. The `subagent` and `subagent_fork` tools and overlapping global child controls are disabled. Workflow retains the base profile’s `spawn` provider, while the underlying Subagent services and both providers remain available to teammates and workflow.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). Applied after `dsh-base`, the patch disables `tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent`, and `tool-subagent-fork`, and inserts the Team service and tool rows with explicit providers and limits.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered patch over `dsh-base` |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| — | No runtime invariant companion is published; the package carries only a static profile patch. The Team domain and tool packages own the mutable relationships it activates. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and publication policy.
- [Agent Teams service](../agent-team/README.md) — durable roster, messaging, and task-board behavior.
- [Agent Teams tools](../tool-agent-team/README.md) — the Team-scoped model tool surface.
- [Base bundle](../../bundle/base/README.md) — the profile layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

### Team policy and tools

#### What the model sees

The Team policy and schemas belong to [`@deepseek-ai/dsh-experimental-tool-agent-team`](../tool-agent-team/README.md). This bundle changes composition only: Team-scoped `list_agents`, `send_message`, and `interrupt_agent` replace the disabled global continuable-child controls. `spawn_teammate` is the direct delegation tool. Workflow’s `agent()` calls create fresh one-shot children; their prompts must contain the context needed for their tasks.

#### Token effect

The bundle adds the Team policy and tool schemas described by `@deepseek-ai/dsh-experimental-tool-agent-team`; it adds no prompt text of its own.

#### KV Cache effect

The bundle's composition is prefix-stable while its patch, Team identity, and configured tool schemas remain unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — the package is public, but no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **Workflow child tools** — the [Team tool visibility limitation](../tool-agent-team/README.md#known-limitations-and-deferred-work) also applies to workflow children.
- **Shared checkout** — every teammate observes the same working directory; this bundle adds no worktree isolation or filesystem locking.
- **Base profile required** — the patch depends on row ids and Subagent providers supplied by `dsh-base`; it is not a standalone profile.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
