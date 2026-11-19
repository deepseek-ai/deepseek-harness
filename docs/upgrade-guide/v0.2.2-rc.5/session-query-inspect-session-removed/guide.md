---
kind: upgrade-guide
description: "ctx.sessionQuery.inspectSession is removed, so a plugin that reads a cold Session through a prepared Session object no longer compiles."
---

# `ctx.sessionQuery.inspectSession` is removed

English | [中文](guide.zh.md)

## Change

`SessionQueryEngine.inspectSession(sessionId, read, signal?)` from `@deepseek-ai/dsh-session-query` is removed. It prepared an unpublished `Session` for a cold Session and passed it to a synchronous getter, so projection handles and owner services could read it. That object was not in the Session store, had no Agent, and could not be appended to. The only in-repository caller, worktree archive cleanup, now reads projection wire values through `observeSession`.

A third-party plugin is affected when it calls `ctx.sessionQuery.inspectSession`; it fails to compile, and an untyped call rejects at run time.

## Migration

1. Search your plugin for `inspectSession(`.
2. Replace each call with an observation and read the projection's wire value by key: `using observation = await ctx.sessionQuery.observeSession(sessionId, { signal })`, then `observation.projections?.values[key]`. The value is computed to the end of the log for live and cold Sessions alike, without attaching or resuming a cold Session.
3. State without a wire view is private to its owner; read it through the owner's service, or ask the owner to add a wire view.
4. Run your typecheck; it passes once no call remains.
