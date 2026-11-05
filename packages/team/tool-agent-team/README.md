---
description: "Four task-board tools and shared-task guidance for Team-enabled Sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-team

English | [中文](README.zh.md)

## Summary

This package lets every agent in a subagent tree create, claim, and complete shared tasks. It adds four task schemas and shared-board guidance. Ordinary subagent controls own discovery, messaging, interruption, and inbox waiting. The base bundle loads the service and tools; new Sessions default to Team mode off.

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

Team tools are available to each model step only while the root Session enables Team mode. Prompt providers read the same selection when evaluated. Ordinary subagent controls remain available.

Mount this package with `@deepseek-ai/dsh-agent-team` when models need the shared board. The root and descendants receive identical task schemas and task policy.

### When to choose it

Choose it whenever the Team domain is mounted and models should use the board; without it, the board is reachable only through `ctx.agentTeams`. Teammates are created and reached through the standard `subagent`, `subagent_fork`, `send_message`, `list_agents`, and `interrupt_agent` tools, so the composition also needs `@deepseek-ai/dsh-tool-subagent` and `@deepseek-ai/dsh-tool-subagent-control`.

### Smallest working example

The plugin takes no configuration; mount it beside the Team domain as in the [agent-team setup](../agent-team/README.md#smallest-working-setup):

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-tool-agent-team'
```

A row that sets `interrupt`, `freshProvider`, or `forkProvider` does not activate, and dsh names the key in its startup warning. The [upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md) maps the removed tools and keys to their replacements, and the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-agent-team) records the empty configuration.

Ask the Lead to start a subagent to review the diff, add a review task, and wait for its result. The `description` explains the subagent’s work; the returned name addresses it.

### What the model can do

The task tools complement the ordinary subagent controls:

- **Manage the task board** — `team_task_create`, `team_task_list`, `team_task_get`, and `team_task_update` add, browse, read, and update shared tasks.
- **Wait for inbox input** — `wait_agent` belongs to `@deepseek-ai/dsh-tool-subagent-control` and remains available without this package.
- **Create and reach teammates** — `subagent`, `subagent_fork`, `send_message`, `list_agents`, and `interrupt_agent` come from the subagent tool packages and are unchanged by this package.

Task `owner` arguments accept the names that `list_agents` shows: `lead`, a full name such as `reviewer/checker`, or a Session id. Task results report `owner` as that name, or as the Session id when the owner has no name; `unowned: true` filters tasks without an owner, while `unowned: false` selects assigned tasks. The `owner` and `unowned` filters cannot be combined. The Team service authorizes `ownerId` Session ids and saves the full name in `ownerName` at assignment. The root may reassign to itself or any reachable continuable descendant; historical roster records grant no authority. Other agents claim ready tasks themselves. Updates enforce ownership and revision checks.

### What success and failure look like

Task tools return compact JSON task views or pages. Stale revisions, unauthorized actions, and unready tasks return errors.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the adapter and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The adapter is built on four commitments:

- **Session-selected tools.** Shared tool registrations select availability from each caller’s root Session; the service resolves tree authority when called.
- **One tool family.** Team registers no messaging, listing, or interruption tool; the standard subagent tools serve Leads and teammates alike.
- **Declared results, compact JSON.** Every tool declares its complete result schema and renders that value as compact JSON, so the compiler checks `execute` against what the model is promised and no result spends tokens on indentation.
- **The domain owns authority.** Tools delegate to `ctx.agentTeams`, which enforces Lead authority and revision checks; the adapter adds no weaker path.

The [subagent teammates Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.md) owns the model-facing and scoping decisions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, removed-key rejection, Team policy and four conditional task tools |

### Policy and tools

One plugin registration provides a dynamic `team:policy` section and four conditional task tools. Each provider reads the caller’s root Session selection, including fork children. An unavailable root disables Team tools and guidance. Tree authority comes from `ctx.subagents.rootOf(agent)`; task owners remain Session ids in `ctx.agentTeams`. Owner arguments resolve through `ctx.subagents.resolveName()`, which grants no authority. Results replace the saved `ownerId` and `ownerName` fields with `owner: ownerName ?? ownerId`. Displaying a task or editing its content requires no descendant catalog reads. Identity, discovery, communication, and waiting belong to [subagent controls](../../subagent/tool-subagent-control/README.md) and remain unchanged when Team mode switches. The subagent runtime delivers final results.

### Scoped registration and teardown

Tool `when` conditions resolve at step preparation, including the first step of new, forked, and resumed Agents. Policy text is evaluated during prompt assembly. An already prepared step retains its tool selection, but task operations check the current mode before starting. Plugin disposal removes all registrations through their owning effects.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the domain service to the exact schemas and the decisions behind the design.

- [agent-team package](../agent-team/README.md) — the `ctx.agentTeams` domain service behind these tools.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and service API.
- [Subagent control tools](../../subagent/tool-subagent-control/README.md) — messaging, listing, interruption, and inbox waiting.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-agent-team) — every tool schema the model receives.
- [Subagent teammates Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.md) — model-facing, scoping, and tool-family decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Team policy system prompt

#### What the model sees

Every Team member's system prompt carries one `team:policy` section; the Lead and every teammate see the same text:

##### Team policy

```markdown
Agent Teams is available in this session.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Use the names returned by subagent, subagent_fork, or list_agents as owner when assigning or filtering shared tasks. The root can reassign tasks to itself or any continuable descendant; other agents claim ready tasks themselves. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. The root agent must wait for required teammates before giving the final answer.

Task changes do not end wait_agent calls, add inbox messages, or start idle agents. Use send_message when another agent needs to act on a task.
```

#### Token effect

The section is a fixed cost on every request of every Team member.

#### KV Cache effect

The text is identical for the Lead and every descendant and does not change while the plugin stays loaded, so it keeps a stable system-prompt prefix, including between a parent and its `subagent_fork` child. Loading or unloading the plugin changes the system prompt of every member and invalidates their cached prefixes.

### Task tool schemas

#### What the model sees

Every member receives the same four task schemas in the [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-agent-team). Results are compact JSON task views or pages. Root-only reassignment is enforced at execution, not through different schemas.

#### Token effect

The four schemas are a fixed cost per request. Tool results add compact JSON; `team_task_list` returns at most 100 tasks per page. An owner name is usually shorter than the 36-character Session id it replaces.

#### KV Cache effect

The schemas are identical for the Lead and every descendant, including `subagent_fork` children, so a fork's tool list matches its parent's request prefix. Tool results append after the reusable prefix. Loading or unloading the plugin changes every member's tool list and invalidates their cached prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the policy and tools cannot guarantee for a team. They are current package constraints, not a comparison with other collaboration surfaces.

- **Prompt policy is coordination, not confinement** — it cannot stop Bash or external processes from writing overlapping files.
- **Task authority needs a live root** — tool availability does not guarantee that the caller’s root remains available when an operation executes.
- **No Web controls** — browser task-board presentation is outside this runtime package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
