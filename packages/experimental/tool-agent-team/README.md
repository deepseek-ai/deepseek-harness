---
description: "Five task-board and wait tools plus coordination guidance for every member of an experimental Team composition."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

English | [中文](README.zh.md)

## Summary

This package lets every Team member coordinate shared work: create, claim, and complete tasks on the shared board, and wait for teammates instead of polling. Each member also receives the shared-checkout coordination policy and a statement of its role. Creating, messaging, listing, and interrupting teammates stay on the standard subagent tools, so the package adds only five tool schemas. It is published under its experimental name and provides no stability guarantee.

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

Add this package on top of `@deepseek-ai/dsh-experimental-agent-team` when Team members should coordinate through tools. Once mounted, the Lead and every subagent below it, fresh or fork, get the same five tools, the same policy section, and a required runtime-context statement of their role.

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

The five tools cover two capabilities; the standard subagent tools cover the third:

- **Manage the task board** — `team_task_create`, `team_task_list`, `team_task_get`, and `team_task_update` add, browse, read, and update shared tasks.
- **Wait for teammates** — `wait_agent` waits for the next task, member status, or inbox change after the call starts.
- **Create and reach teammates** — `subagent`, `subagent_fork`, `send_message`, `list_agents`, and `interrupt_agent` come from the subagent tool packages and are unchanged by this package.

Task `owner` arguments and `ownerId` results use Session ids. Descriptions are display text and may repeat. Any member can use the board; only the Lead reassigns tasks. Updates enforce ownership and revision checks, rejecting stale edits.

### What success and failure look like

Task tools return compact JSON task views or task pages. A stale `expected_revision`, an unauthorized action, or an unready task is reported as a tool error instead of overwriting newer work. `wait_agent` returns `{ "timedOut": false }` after a change and `{ "timedOut": true }` at its timeout; when no other member is running, it returns `noProgress` with reason `no-active-peer` right away, telling the caller to wake a teammate with `send_message` first.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the adapter and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The adapter is built on four commitments:

- **Scoped, not global.** Every registration lives on the member Agent's own `ctx`; installation uses the Team membership available when the Agent is published.
- **One tool family.** Team registers no messaging, listing, or interruption tool; the standard subagent tools serve Leads and teammates alike.
- **Declared results, compact JSON.** Every tool declares its complete result schema and renders that value as compact JSON, so the compiler checks `execute` against what the model is promised and no result spends tokens on indentation.
- **The domain owns authority.** Tools delegate to `ctx.agentTeams`, which enforces Lead authority and revision checks; the adapter adds no weaker path.

The [subagent teammates Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.md) owns the model-facing and scoping decisions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: removed-key rejection, the fixed policy text, identity context, and the five scoped tool registrations |

### Policy and tools

One `team:policy` section and one required `team:identity` runtime-context entry on the member scope carry the shared coordination rules and the member's role; the fixed text and the five tool registrations are declared in [`src/index.ts`](src/index.ts). The five tool schemas are registered in every scope recognized as a Team member at publication, including fork children, so parent and fork requests list identical tools and system prompts. No registration shares a name with a subagent control, so `send_message`, `list_agents`, and `interrupt_agent` resolve to the global subagent tools in every member scope.

### Scoped registration and teardown

`maybeInstall` runs for every live Agent and subscribes to `agent/created`; it skips Agents without Team membership. Disposal of an Agent runs the installed disposer, and plugin HMR disposes every installed scope before reinstall. Each disposer unwinds registrations in reverse order, so a failed install cannot leave a partial scope.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the domain service to the exact schemas and the decisions behind the design.

- [agent-team package](../agent-team/README.md) — the `ctx.agentTeams` domain service behind these tools.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and service API.
- [Subagent control tools](../../subagent/tool-subagent-control/README.md) — messaging, listing, and interruption by Session id.
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
Agent Teams is available in this session. Teammates are subagents. Use list_agents to discover the entire Team and send_message with an agent id to contact any other listed member with running or inactive status. Descriptions explain responsibilities and may repeat.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use agent ids as task owners. The Lead can reassign to itself, its direct continuable children, or historical members; other descendants claim tasks themselves. list_agents includes the root and all reachable continuable descendants, with parent ids and depth; discovery does not grant assignment authority. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. A successful send does not mean the recipient has processed it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, make sure another required member is running; use send_message first to wake a required inactive member. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member is running. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.
```

#### Token effect

The section is a fixed cost on every request of every Team member.

#### KV Cache effect

The text is identical for the Lead and every descendant and does not change while the plugin stays loaded, so it keeps a stable system-prompt prefix, including between a parent and its `subagent_fork` child. Loading or unloading the plugin changes the system prompt of every member and invalidates their cached prefixes.

### Team identity runtime context

#### What the model sees

Required `team:identity` runtime context states `You are the Team Lead. Your agent id is "<lead id>".` for a root and `You are a teammate in the Team led by agent "<lead id>".` for a subagent. It follows current membership, survives optional-context suppression, and is restored after compaction. An ordinary fork of a teammate is a new root and receives the Lead statement.

#### Token effect

Identity is part of the complete runtime-context snapshot. An unchanged retained snapshot adds no message; changed or removed context causes the loop to append a complete snapshot, including identity.

#### KV Cache effect

Identity arrives in a runtime-context snapshot after the request prefix, so a `subagent_fork` child keeps its parent's system prompt, tools, and inherited messages and appends its teammate statement after them. Actual provider cache hits remain best-effort.

### Task and wait tool schemas

#### What the model sees

Every Team member receives the same five schemas, listed in the [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-agent-team). Results are compact JSON task views, task pages, or wait values. When no other member is running, `wait_agent` returns `noProgress` with reason `no-active-peer` and the message `No other Team member is running. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake a required inactive member before waiting again.` Lead-only `reassign` is enforced at execution, not by a different schema.

#### Token effect

The five schemas are a fixed cost on every Team member request. Tool calls add compact JSON results; `team_task_list` returns at most 100 tasks per page.

#### KV Cache effect

The schemas are identical for the Lead and every descendant, including `subagent_fork` children, so a fork's tool list matches its parent's request prefix. Tool results append after the reusable prefix. Loading or unloading the plugin changes every member's tool list and invalidates their cached prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the policy and tools cannot guarantee for a team. They are current package constraints, not a comparison with other collaboration surfaces.

- **Prompt policy is coordination, not confinement** — it cannot stop Bash or external processes from writing overlapping files.
- **Installation follows publication** — an Agent that is not a Team member when it is published, such as a subagent whose parent is not loaded, receives no Team tools, policy, or identity, even after its parent loads.
- **No Web controls** — browser roster and task-board presentation is outside this runtime package.
- **Experimental prototype with no stability promise** — the package is public, but its schemas can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
