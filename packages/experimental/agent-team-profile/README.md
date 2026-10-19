---
description: "Enable a shared task board, task tools, and Web task panel with one experimental bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-team-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-team-profile` adds the [Agent Teams](../agent-team/README.md) task board, task tools, and Web task panel to an existing subagent tree. Base-profile delegation, messaging, waiting, and member navigation stay available independently. The bundle ships with dsh switched off. Enable it from the Plugins page or add it to an initialized profile.

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

The layer adds the task domain, four task-board tools, and task UI without disabling base rows. The Lead uses `subagent` for fresh context or `subagent_fork` for inherited history. Standard controls address agents by id.

In Web and Desktop conversations, the [Team UI](../client-ui-agent-team/README.md) displays shared tasks; ordinary subagent navigation opens member conversations. The bundle switch controls task tools and task UI. The Plugins page reads the bundle’s [icon](icon.svg) from `package.json.icon`, including while disabled.

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
- [Agent Teams service](../agent-team/README.md) — durable shared tasks and in-memory wait signals.
- [Agent Teams tools](../tool-agent-team/README.md) — task tools and shared-board policy.
- [Agent Teams browser UI](../client-ui-agent-team/README.md) — the shared task panel.
- [Base bundle](../../bundle/base/README.md) — the profile layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

### Team policy and tools

#### What the model sees

The task policy and four task schemas belong to [`@deepseek-ai/dsh-experimental-tool-agent-team`](../tool-agent-team/README.md). This bundle changes composition only; ordinary subagent identity, control tools, and inbox waiting remain owned by the base-profile subagent controls.

#### Token effect

The bundle adds the task policy and four schemas owned by `@deepseek-ai/dsh-experimental-tool-agent-team`; it contributes no prompt text of its own.

#### KV Cache effect

Every member, including `subagent_fork` children, receives the same Team policy and tool schemas, so a fork keeps its parent's request prefix; enabling or disabling the bundle changes both for every member. Team identity is appended through runtime-context snapshots; [Team tools](../tool-agent-team/README.md#model-experience) define snapshot reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — the package ships with the installation switched off; no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **Workflow children share the board** — continuable Workflow `agent()` descendants receive task tools and use ordinary subagent discovery and communication.
- **Shared checkout** — every teammate observes the same working directory; this bundle adds no worktree isolation or filesystem locking.
- **Base profile required** — teammates are created and reached through the Subagent services, providers, and tools that `dsh-base` mounts; the layer is not a standalone profile.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
