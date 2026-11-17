---
kind: upgrade-guide
description: "Agent factory callers create forks by naming the shared parent prefix beside the seed."
---

# Fork creation takes a parent source

English | [中文](guide.zh.md)

## Change

A fork passes `CreateAgentOptions.parentSource: { sessionId, endSeq }` beside its `seed`: the parent and the exclusive length of the parent prefix the child shares. The first `endSeq` seed events must be the parent's stored events as a persistence read or observation returned them. The factory forwards the constructed log with that parent as `SessionPersistenceCreateOptions.parentSource`, and the backend stores it before `create()` resolves: SQLite drains a live parent writer, references the persisted prefix, and writes only the events after `endSeq`; JSONL copies the log. A parent whose stored history is shorter than `endSeq` rejects creation on SQLite with `SESSION_FORK_PREFIX_NOT_PERSISTED`.

The `session/fork` Remote request and its inclusive `atSeq` remain unchanged. Later parent events do not extend the child history. Direct replay or restoration using complete `seed` events remains available to Agent factory callers, and `ContinuableCreateSpec.seed` keeps supplying the subagent prefix.

## Migration

1. Add `parentSource: { sessionId, endSeq }` beside `seed` when the history comes from a parent Session; keep `inheritedEventCount` and `meta.isSeeded`.
2. Supply the parent prefix exactly as persistence returned it. A cold observation's `persistedEventCount` bounds `endSeq`; events after it, such as interrupted-turn repairs, belong to the child.
3. Fork at a completed turn, reopen the child, and confirm it contains the selected history. Append another parent turn and confirm the child history remains unchanged. See the [Agent creation reference](../../../../packages/core/agent/README.md#use-this-package) for the source fields and the [persistence service](../../../../packages/session/session-persistence/README.md) for backend storage.
