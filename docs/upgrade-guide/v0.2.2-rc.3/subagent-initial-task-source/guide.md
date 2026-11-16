---
kind: upgrade-guide
description: "In-process continuable subagents record their initial delegated task as an agent-message from the parent agent instead of a user message."
---

# Subagent initial tasks are agent messages

English | [中文](guide.zh.md)

## Change

In-process continuable subagents started by `subagent-spawn-in-process` or `subagent-fork-in-process` record the initial delegated task as a message from the parent agent. Its `user/message` source changes from `{ "kind": "user" }` to `{ "kind": "agent-message", "form": "relay", "senderSessionId": "<parent Session id>" }`, and its content starts with a text block `Agent <parent name> sent a message: ` before the task blocks. Child Session logs, SDK Session event notifications, and Python SDK results show the new form. Sessions written earlier keep the old form.

Consumers that treat `user` sources as human input no longer apply to the task: `$skill` mentions in it do not load skills, Session references in it are not expanded, Markdown export and the turn outline omit it, and a child without human messages gets no fallback title. Direct human messages to a child keep the `user` source and their original content.

## Migration

1. Where code finds a child's task as its first `user`-source message, match an `agent-message` source whose `senderSessionId` equals the child Session's `parentSession`, and drop the first content block to read the task text. Keep accepting `user` for Sessions written before the upgrade.
2. Where a delegated task relies on `$skill` to load a skill, name the skill in the task and let the child call the `skill` tool.
3. Confirm by starting a continuable child and checking that its first non-context `user/message` has the `agent-message` source and the sender prefix.
