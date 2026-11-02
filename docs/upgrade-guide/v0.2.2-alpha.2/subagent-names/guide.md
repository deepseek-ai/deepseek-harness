---
kind: upgrade-guide
description: "Subagent control and Team task tools address agents by name, list_agents rows change, and subagent catalogs write payload version 3."
---

# Subagent tools address agents by name

English | [中文](guide.zh.md)

## Change

Each new subagent has a name that is unique among its creator's children and recorded in the creator's `subagent/catalog` entry. The root is `lead`; a descendant's full name is its path from the root, such as `reviewer/checker`. The [subagent runtime](../../../../packages/subagent/subagent/README.md#agent-names) defines the name rule. Children created before upgrading keep their Session ids as names. These changes affect scripts, Code-mode (PTC) programs, SDK callers, and recorded transcripts that call or parse these tools, and code that reads catalogs or constructs activations:

- `send_message({ agent_id, message })` becomes `send_message({ agent, message })`, and `interrupt_agent({ agent_id })` becomes `interrupt_agent({ agent })`. `agent` accepts a name or a Session id. A call that still passes `agent_id` fails argument validation.
- `subagent`, `subagent_fork`, and `subagent_oar` accept an optional `name`. They return `started subagent <name>`, and their result is `{ kind: 'activation', subagentId, name }`.
- `list_agents` returns `{ name, status, description? }` rows instead of rows with `kind`, `id`, `label`, `parent`, `depth`, and `reason`. Unreadable branches report `corrupt`, `unsupported`, or `unavailable` as `status`. Text rows read `<name> [<status>] — <description>`.
- Team task results replace `ownerId` with `owner`, the owner's name. `team_task_list` and `team_task_update` accept a name as `owner`.
- Local and parent-delivered external creation write `subagent/catalog` payload version 3. Releases before this one reject catalogs that contain it, so they cannot open Sessions that create subagents after upgrading. See the [persistence acknowledgement](../../../persistence-changes/2026-11-02-subagent-catalog-names.md).
- `SubagentActivation` has a required `name` field, and `SubagentActivationSpec` accepts an optional `name`.

## Migration

1. In scripts, PTC programs, and SDK calls, rename the `agent_id` argument of `send_message` and `interrupt_agent` to `agent`. Pass the name that `list_agents` or the start receipt reports; a saved Session id still works.
2. Update parsers of `list_agents` output to read `name`, `status`, and `description`. Derive a member's creator from its name: the text before the last `/`, or `lead` for a name without `/`. Children created before upgrading appear under their Session ids.
3. Update Team task consumers to read `owner` instead of `ownerId`. Host code that calls `ctx.agentTeams` still reads `ownerId`.
4. Update recorded transcripts or fixtures that contain `agent_id` arguments, `started subagent <Session id>` receipts, identity runtime context text, or the earlier `list_agents` rows.
5. In code that constructs `SubagentActivation` values, such as test doubles, add `name`. Code that reads catalog rows can read the optional `name` field.
6. Upgrade every process that opens the same Session store before creating subagents. Older releases cannot open Sessions that contain catalog payload version 3.
7. To confirm the change, start a subagent with `name: "reviewer"` and check that the receipt reads `started subagent reviewer`, that `list_agents` lists `reviewer`, and that `send_message({ agent: "reviewer", message })` succeeds.
