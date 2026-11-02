---
kind: upgrade-guide
description: "The subagent service removes drainChildren, listChildren, and list."
---

# Subagent service method removal

English | [中文](guide.zh.md)

## Change

`ctx.subagents` removes `drainChildren(parent, childIds)`, `listChildren(parentSessionId, signal?)`, and `list()`. This affects plugins that release resident children by id, read direct-child catalogs through the service, or enumerate registered provider names.

## Migration

1. Retain the activation returned by `startActivation()` and await its `dispose()` to release that exact execution. An old activation cannot release a later execution of the same Session. There is no replacement for releasing the current resident child by id; use `drainDescendants([root])` only when closing the entire tree. `interrupt()` stops current work but preserves a local Activation.
2. For direct-child entries, use `ctx.sessionQuery.observeSession(parentSessionId, { signal })`, read `observation.projections?.values.subagentCatalog`, and dispose the observation with `using`. Load Session Query and the subagent service, and treat a missing catalog projection as unavailable. Keep `listDescendants()` for recursive discovery; its rows differ from direct catalog entries.
3. Use `getProvider(name)` to check known provider names. The service no longer enumerates all registered names.
4. Rebuild plugins against the updated service declarations. Verify registration and unload checks, exact-activation disposal, and catalog observation cleanup.
