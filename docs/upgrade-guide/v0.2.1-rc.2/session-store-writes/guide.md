---
kind: upgrade-guide
description: "Store-owned Sessions reject writes before creation announcement completes and after removal."
---
# Store-owned Session writes follow publication

English | [中文](guide.zh.md)

## Change

`Session.append()` and `appendPluginRecord()` on store-owned instances reject writes until the instance enters a `SessionStore` and its synchronous `session/created` dispatch completes, and after it leaves. Store ownership starts at `prepare()` or `enter()`. Creation listeners cannot append; a failed announcement leaves writes disabled. Independent `Session.create()` and `Session.fromRestore()` instances remain writable without notifying store observers. Constructor, restore, and fork history still load normally. The Agent factory completes `session/created` before invoking setup; `agent/created` still follows setup. During `session/created`, `ctx.agents.get(session.id)` now returns `undefined`. Listeners registered inside setup miss their own Session’s creation announcement. Setup events now reach live Session subscribers as well as persisted history.

A failed setup retains constructor history and setup events already written to persistence. A failed seeded creation, including a fork, can therefore leave a stored Session; its identity is no longer available for a new creation.

Permission defaults are initialized during `agent/created`, so creating a bare Session no longer pins them. `dsh-permission-presets` now requires the `agents` service as well as its existing dependencies.

## Migration

1. Use `ctx.sessions.create()` for a writable Session owned by the calling fiber. For explicit lifecycle ownership, call `prepare()`, `enter()`, and `announce()` before appending; retain the returned disposer until all closing events finish.
2. Keep `Session.create()` and `Session.fromRestore()` for independent log construction. Build history before handing the instance to `enter()`, or pass it as the seed to `prepare()`. Removal does not restore independent write access. Cold durable writes use the persistence write handle.
3. Move writes and Agent-dependent work out of `session/created` listeners. Use setup or `agent/created` for writes; use the supplied Agent in setup and the `agent/created` payload instead of looking up an Agent during Session announcement.
4. Replace setup-installed observers of their own `session/created` with `agent/created` listeners. Keep Session creation observers in a scope installed before factory creation starts.
5. After failed creation with persisted history, retry with `ctx.agents.resume({ resumeSessionId })` instead of `create()` on the same id. Retain the stored history for recovery.
6. Custom profiles mounting `dsh-permission-presets` must also mount `dsh-agent`, the provider of `agents`, and await permission plugin activation before creating Agents.
7. Verify that creation observers see the expected registry state, permission initialization completes, failed creation can resume its stored history, and rejected appends leave history unchanged.
