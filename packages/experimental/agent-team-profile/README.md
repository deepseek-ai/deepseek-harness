---
description: "Enable team collaboration, tools, and the Web roster and task board with one experimental bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-team-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-team-profile` enables [Agent Teams](../agent-team/README.md) collaboration, tools, and Web UI with one bundle. The Lead starts subagents as teammates that share a task board and wait for each other; Web shows members, shared tasks, and teammate sessions. The base profile's delegation and messaging tools stay available. The bundle ships with dsh switched off. Enable it from the Plugins page or add it to an initialized profile.

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

The profile must already contain `@deepseek-ai/dsh-base`, whose Subagent services, providers, and tools this layer relies on. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-agent-team-profile` removes the bundle from the profile's ordered layer list.

Enable Agent Teams on the Web or Desktop Plugins page to activate both tools and UI. For a CLI Web profile, use:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-team-profile
```

In an existing profile’s `package.json`, keep `@deepseek-ai/dsh-experimental-agent-team-profile` in `dsh.profile.bundles` and remove the separate `@deepseek-ai/dsh-experimental-agent-team-web-profile` entry. User patches targeting `ui-agent-team` still apply. A user patch that sets a removed Team key keeps that Team row from activating; the [upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md) lists the removed keys and tools.

### What you get

The layer adds the Team domain, task-board and wait tools, and UI, without disabling base rows. The Lead uses `subagent` for fresh context or `subagent_fork` for inherited history, describing the task with `description`. Standard controls use agent ids.

In Web and Desktop conversations, the [Team UI](../client-ui-agent-team/README.md) displays the member roster and shared task board and opens teammate sessions. The same bundle switch controls the tools and browser UI. The Plugins page reads the bundle's [icon](icon.svg) from its `package.json.icon` declaration, including while the bundle is disabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). Applied after `dsh-base`, the patch only inserts rows: the Team service with `maxTasks: 256`, the Team tools, and the UI. The UI plugin has an inert Host entry; only the Web Client loader mounts its browser entry, so headless needs no Web server.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered patch over `dsh-base` |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and publication policy.
- [Agent Teams service](../agent-team/README.md) — Team membership, roster, and the durable task board.
- [Agent Teams tools](../tool-agent-team/README.md) — the task and wait tools, policy, and identity every member receives.
- [Agent Teams browser UI](../client-ui-agent-team/README.md) — roster, task board, and teammate session navigation.
- [Base bundle](../../bundle/base/README.md) — the profile layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

### Team policy and tools

#### What the model sees

The Team policy, identity, and schemas belong to [`@deepseek-ai/dsh-experimental-tool-agent-team`](../tool-agent-team/README.md). This bundle changes composition only: every Team member gains the five task and wait tools, while `subagent`, `subagent_fork`, `send_message`, `list_agents`, and `interrupt_agent` keep their base-profile schemas.

#### Token effect

The bundle adds the Team policy section, the identity statement, and the five tool schemas described by `@deepseek-ai/dsh-experimental-tool-agent-team`; it adds no prompt text of its own.

#### KV Cache effect

Every member, including `subagent_fork` children, receives the same Team policy and tool schemas, so a fork keeps its parent's request prefix; enabling or disabling the bundle changes both for every member. Team identity is appended through runtime-context snapshots; [Team tools](../tool-agent-team/README.md#model-experience) define snapshot reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — the package ships with the installation switched off; no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **Workflow children join the Team** — continuable Workflow `agent()` children receive the same Team tools, policy, and sibling message routes. Direct children of the Lead appear in its roster.
- **Shared checkout** — every teammate observes the same working directory; this bundle adds no worktree isolation or filesystem locking.
- **Base profile required** — teammates are created and reached through the Subagent services, providers, and tools that `dsh-base` mounts; the layer is not a standalone profile.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
