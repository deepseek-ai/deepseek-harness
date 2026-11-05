---
kind: upgrade-guide
description: "Ordinary Session forks stop recording their source relationship and stop appearing as subagents."
---

# Ordinary forks are independent Sessions

English | [中文](guide.zh.md)

## Change

Ordinary forks copy the selected history and continue independently. They omit `SessionHeader.parentSession` and the Client's `parentSessionId`; no replacement source field is written. Subagents, including fork-backend subagents, retain their direct creator. Existing logs retain their recorded metadata.

SDK `subagent.started` excludes ordinary forks, including historical ones carrying a parent id. ACP list/resume admits ordinary forks; headless adoption also accepts them when cwd and preset checks pass. Client lists no longer indent them or insert newly discovered forks before their sources; saved manual positions remain intact. Source-based trace queries, parent filters, telemetry, and remote logs cannot recover the source of new ordinary forks. Workspace binding, optional title increments, inherited history, and seed boundaries remain available.

The Session format stays V4. Older V4 readers may reject a parentless fork containing inherited delivery acknowledgements as a corrupt log with `current-generation delivery marker names the wrong Session`. The tested readers refuse before granting a handle or truncating the file. They do not provide an upgrade-specific diagnostic. See the [compatibility decision](../../../../.agents/notes/implemented/architecture/2026-10-23-independent-session-forks.md).

## Migration

1. Upgrade every reader and writer sharing the Session directory before resuming newly created forks. Do not edit old headers or delete delivery records to bypass an older reader's rejection.
2. Replace consumer checks that treat any `parentSession` as a subagent with `origin === 'subagent'`. Continuation still requires a valid descriptor from the Session's own event range; inherited descriptors do not establish its identity.
3. Remove any ordinary-fork workflow that requires persistent source tracing. Keep source-dependent actions such as workspace selection within the fork operation.
4. Confirm that an ordinary fork has no parent field, survives restart with inherited delivery records, and produces no `subagent.started`; confirm that real subagents retain their creator and notification.
