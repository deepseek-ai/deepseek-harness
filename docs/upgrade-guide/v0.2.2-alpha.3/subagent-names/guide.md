---
kind: upgrade-guide
description: "Subagent control and Team task tools address agents by name, list_agents rows change, and subagent catalogs write payload version 3."
---

# Subagent tools address agents by name

English | [中文](guide.zh.md)

## Change

New subagents have sibling-unique names in their creator's `subagent/catalog`. The root is `lead`; descendant names are paths such as `reviewer/checker`. The [subagent runtime](../../../../packages/subagent/subagent/README.md#agent-names) defines naming rules. Historical children keep their Session ids. Scripts, PTC, SDK callers, and transcripts must adopt these changes:

- `send_message({ agent_id, message })` becomes `send_message({ agent, message })`, and `interrupt_agent({ agent_id })` becomes `interrupt_agent({ agent })`. `agent` accepts a name or a Session id. A call that still passes `agent_id` fails argument validation.
- `subagent`, `subagent_fork`, and `subagent_oar` accept an optional `name`. They return `started subagent <name>` with result `{ kind: 'activation', name }`.
- `list_agents` returns `{ name, status, description? }` rows instead of rows with `kind`, `id`, `label`, `parent`, `depth`, and `reason`. Unreadable branches report `corrupt`, `unsupported`, or `unavailable` as `status`. Text rows read `<name> [<status>] — <description>`.
- Team task results replace `ownerId` with `owner`, the owner's name. `team_task_list` and `team_task_update` accept a name as `owner`. To list tasks without an owner, use `unowned: true` instead of `owner: "unowned"`.
- Local and parent-delivered external creation write `subagent/catalog` payload version 3. Releases before this one reject catalogs that contain it, so they cannot open Sessions that create subagents after upgrading. See the [persistence acknowledgement](../../../persistence-changes/2026-11-02-subagent-catalog-names.md).
- `SubagentActivation` has a required `name` field, and `SubagentActivationSpec` accepts an optional `name`.

## Migration

1. In scripts, PTC programs, and SDK calls, rename the `agent_id` argument of `send_message` and `interrupt_agent` to `agent`. Pass the name that `list_agents` or the start receipt reports; a saved Session id still works.
2. Update parsers of `list_agents` output to read `name`, `status`, and `description`. Only complete named paths encode creators: the prefix before the last `/`, or `lead` without `/`. Unnamed children or ancestors cause Session-id fallback; these rows expose neither creator nor depth.
3. Update Team task consumers to read `owner` instead of `ownerId`. Host code that calls `ctx.agentTeams` still reads `ownerId`; display `ownerName ?? ownerId`. New assignments persist optional `ownerName`; historical records remain unchanged. Older projections reject named tasks; see the [acknowledgement](../../../persistence-changes/2026-11-02-team-task-owner-names.md).
4. Read `name` instead of `subagentId` from delegation tool results. Update recorded transcripts or fixtures that contain `agent_id` arguments, `started subagent <Session id>` receipts, identity runtime context text, `Agent <Session id> sent a message` signatures, `Background subagent <Session id>` notices, or the earlier `list_agents` rows. Signatures and notices now use names.
5. Add `name` when constructing `SubagentActivation` values. Code that reads catalog rows can read the optional `name` field.
6. Upgrade every process that opens the same Session store before creating subagents. Older releases cannot open Sessions that contain catalog payload version 3.
7. To confirm the change, start a subagent with `name: "reviewer"` and check that the receipt reads `started subagent reviewer`, that `list_agents` lists `reviewer`, and that `send_message({ agent: "reviewer", message })` succeeds.
