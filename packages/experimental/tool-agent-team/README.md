---
description: "Four task-board tools and shared-task guidance for an experimental Team composition."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

English | [中文](README.zh.md)

## Summary

This package lets every agent in a subagent tree create, claim, and complete shared tasks. It adds four task schemas and shared-board guidance. Ordinary subagent controls own discovery, messaging, interruption, inbox waiting, and agent identity. The package is experimental and provides no stability guarantee.

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

Mount this package with `@deepseek-ai/dsh-experimental-agent-team` when models need the shared board. The root and descendants receive identical task schemas and task policy.

### When to choose it

Choose it whenever the Team domain is mounted and models should use the board; without it, the board is reachable only through `ctx.agentTeams`. Teammates are created and reached through the standard `subagent`, `subagent_fork`, `send_message`, `list_agents`, and `interrupt_agent` tools, so the composition also needs `@deepseek-ai/dsh-tool-subagent` and `@deepseek-ai/dsh-tool-subagent-control`.

### Smallest working example

The plugin takes no configuration; mount it beside the Team domain as in the [agent-team setup](../agent-team/README.md#smallest-working-setup):

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

A row that sets `interrupt`, `freshProvider`, or `forkProvider` does not activate, and dsh names the key in its startup warning. The [upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md) maps the removed tools and keys to their replacements, and the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-tool-agent-team) records the empty configuration.

Ask the Lead to start a subagent to review the diff, add a review task, and wait for its result. The `description` explains the subagent’s work; the returned id addresses it.

### What the model can do

The task tools complement the ordinary subagent controls:

- **Manage the task board** — `team_task_create`, `team_task_list`, `team_task_get`, and `team_task_update` add, browse, read, and update shared tasks.
- **Wait for inbox input** — `wait_agent` belongs to `@deepseek-ai/dsh-tool-subagent-control` and remains available without this package.
- **Create and reach teammates** — `subagent`, `subagent_fork`, `send_message`, `list_agents`, and `interrupt_agent` come from the subagent tool packages and are unchanged by this package.

Task `owner` arguments and `ownerId` results use Session ids. The root may reassign to itself or any reachable continuable descendant; historical roster records grant no authority. Other agents claim ready tasks themselves. Updates enforce ownership and revision checks.

### What success and failure look like

Task tools return compact JSON task views or pages. Stale revisions, unauthorized actions, and unready tasks return errors. A notification failure after commit reports the committed task and failed recipients; read the task before recovery and do not blindly repeat a create call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the adapter and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The adapter is built on four commitments:

- **Agent-scoped registration.** Every live Agent receives its task tools and policy on its own `ctx`; the service resolves tree authority when called.
- **One tool family.** Team registers no messaging, listing, or interruption tool; the standard subagent tools serve Leads and teammates alike.
- **Declared results, compact JSON.** Every tool declares its complete result schema and renders that value as compact JSON, so the compiler checks `execute` against what the model is promised and no result spends tokens on indentation.
- **The domain owns authority.** Tools delegate to `ctx.agentTeams`, which enforces Lead authority and revision checks; the adapter adds no weaker path.

The [subagent teammates Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.md) owns the model-facing and scoping decisions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, removed-key rejection, task policy, and four scoped task tools |

### Policy and tools

One `team:policy` section and four task schemas are registered on each Agent scope, including fork children. Identity, communication, waiting, and final-result coordination belong to [subagent controls](../../subagent/tool-subagent-control/README.md). Team-specific runtime identity is not injected.

### Scoped registration and teardown

Installation covers current live Agents and subscribes to `agent/created`. Agent disposal and plugin HMR unwind registrations in reverse order; a failed install cannot leave a partial scope.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the domain service to the exact schemas and the decisions behind the design.

- [agent-team package](../agent-team/README.md) — the `ctx.agentTeams` domain service behind these tools.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and service API.
- [Subagent control tools](../../subagent/tool-subagent-control/README.md) — identity, messaging, listing, interruption, and inbox waiting.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-agent-team) — every tool schema the model receives.
- [Subagent teammates Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.md) — model-facing, scoping, and tool-family decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Team policy system prompt

#### What the model sees

Every Team member's system prompt carries one `team:policy` section; the Lead and every teammate see the same text:

##### Team policy

```markdown
A shared task board is available to every agent in your subagent tree. Task owners are agent ids from list_agents. The root can reassign tasks to itself or any continuable descendant; other agents claim ready tasks themselves.

Read tasks with team_task_list or team_task_get, claim with the current revision, perform the work, then complete the task. Dependencies determine readiness; write scopes describe expected edits and overlapping scopes are advisory, not locks. Task readiness does not start an agent.

Task changes notify other live agents through their inbox. Consecutive updates may share one pending notice. After a task-board notice, read the latest tasks before acting. wait_agent receives these notices through the same inbox as other messages. A notice does not start an idle agent; use send_message when it needs to continue working.
```

#### Token effect

The section is a fixed cost on every request of every Team member.

#### KV Cache effect

The text is identical for the Lead and every descendant and does not change while the plugin stays loaded, so it keeps a stable system-prompt prefix, including between a parent and its `subagent_fork` child. Loading or unloading the plugin changes the system prompt of every member and invalidates their cached prefixes.

### Task tool schemas

#### What the model sees

Every member receives the same four task schemas in the [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-agent-team). Results are compact JSON task views or pages. Root-only reassignment is enforced at execution, not through different schemas.

#### Token effect

The four schemas are a fixed cost per request. Tool results add compact JSON; `team_task_list` returns at most 100 tasks per page.

#### KV Cache effect

The schemas are identical for the Lead and every descendant, including `subagent_fork` children, so a fork's tool list matches its parent's request prefix. Tool results append after the reusable prefix. Loading or unloading the plugin changes every member's tool list and invalidates their cached prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the policy and tools cannot guarantee for a team. They are current package constraints, not a comparison with other collaboration surfaces.

- **Prompt policy is coordination, not confinement** — it cannot stop Bash or external processes from writing overlapping files.
- **Task authority needs a live root** — tool availability does not guarantee that the caller’s root remains available when an operation executes.
- **No Web controls** — browser task-board presentation is outside this runtime package.
- **Experimental prototype with no stability promise** — the package is public, but its schemas can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
