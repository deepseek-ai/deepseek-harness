---
kind: upgrade-guide
description: "Task-board changes no longer end wait_agent calls; send a message to request further work."
---
# Agent waits require inbox input

English | [中文](guide.zh.md)

## Change

`wait_agent` waits only for the calling Agent's next-step inbox. Task creation, assignment, completion, and other task updates no longer end an active wait. They do not add inbox messages or start idle Agents. Queued next-turn input and other Agents' status changes also leave the wait pending.

Existing next-step input returns immediately; new messages, completion notifications, and user steering end the wait without consuming that input. Timeout and cancellation behavior remain unchanged.

## Migration

1. After changing a task, use `send_message` when its owner or another member needs to act on the update. Do not rely on a task mutation to release `wait_agent`.
2. Read current task state before acting; a task update is not a message or an instruction to begin a new turn.
3. Verify that a task update leaves an empty-inbox wait pending, then send a message and confirm that the wait returns with `timedOut: false`.
