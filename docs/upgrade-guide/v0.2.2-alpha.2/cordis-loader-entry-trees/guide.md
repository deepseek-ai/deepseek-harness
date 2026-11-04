---
kind: upgrade-guide
description: "Loader entry trees report mutations through commit(change), and Include persists them through a journal."
---

# Loader entry tree reports and Include persistence

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/cordis-plugin-loader` follows Loader 1.0.0-rc.8, and `@deepseek-ai/cordis-plugin-include` follows Include 1.1.1. This affects `cordis.yml` and patch files, code that subclasses `EntryTree`, and code that calls `applyEntryPatches` or relies on Include writes.

- `EntryTree.write()` is removed. Subclasses implement `commit(change: EntryChange)`, which receives each create, update, move, removal and explicit Fiber save synchronously. In-memory trees implement a no-op.
- `applyEntryPatches(data, patches, warn)` always returns cloned entries, including without patches, and clones inserted rows. Callers can no longer mutate the input through the result.
- Include persists runtime changes through a journal reconciled with the latest file. File edits win conflicting fields and are logged as conflicts. Changes to patch-owned fields and inserted rows update the parent Include's patches. `flush()` waits for pending writes and rejects while changes remain unsaved; `refresh()` and `stop()` return the same result.
- Include writes generated ids back into file rows that had none. Runtime changes to rows inserted by patches, including bundle rows, update the parent's patches instead of the included file. The parent of the `dsh` profile's root Include is the in-memory Loader, so such changes, for example a bundle row's self-disposal `disabled: true`, no longer survive a restart; previously the whole patched tree was written into `cordis.yml`.

## Migration

1. In `EntryTree` subclasses, replace `write()` with `commit(change)`. Persist from `change.options` and `change.legacy`: a missing `legacy` is a creation and a missing `options` is a removal.
2. Treat the `applyEntryPatches` result as the only copy to modify.
3. Where code needs a runtime change on disk, await `include.flush()`; for patch-owned changes, flush the child Include and then its parent.
4. Start the application and confirm that runtime edits appear in the configuration file after `flush()`.
