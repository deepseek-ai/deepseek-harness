---
kind: upgrade-guide
description: "Loader entry trees report mutations through commit(change), reject ids containing a colon, and Include persists them through a journal."
---

# Loader entry tree reports and Include persistence

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/cordis-plugin-loader` follows Loader 1.0.0-rc.8, and `@deepseek-ai/cordis-plugin-include` follows Include 1.1.1. This affects `cordis.yml` and patch files, code that subclasses `EntryTree`, and code that calls `applyEntryPatches` or relies on Include writes.

- `EntryTree.write()` is removed. Subclasses implement `commit(change: EntryChange)`, which receives each create, update, move, removal and explicit Fiber save synchronously. In-memory trees implement a no-op.
- An entry `id` containing `:` is rejected, because `:` separates nested tree paths. A configured row such as `id: foo:bar` previously mounted; it is now logged as an error and skipped, and a programmatic `create()` throws.
- `applyEntryPatches(data, patches, warn)` always returns cloned entries, including without patches, and clones inserted rows. Callers can no longer mutate the input through the result.
- Include persists runtime changes through a journal reconciled with the latest file. File edits win conflicting fields and are logged as conflicts. Changes to patch-owned fields and inserted rows update the parent Include's patches. `flush()` waits for pending writes and rejects while changes remain unsaved; `refresh()` and `stop()` return the same result.

## Migration

1. Rename entry ids that contain `:` in `cordis.yml`, profile patches and `--patch` overlays, for example `foo:bar` to `foo-bar`, and update patches that address them.
2. In `EntryTree` subclasses, replace `write()` with `commit(change)`. Persist from `change.options` and `change.legacy`: a missing `legacy` is a creation and a missing `options` is a removal.
3. Treat the `applyEntryPatches` result as the only copy to modify.
4. Where code needs a runtime change on disk, await `include.flush()`; for patch-owned changes, flush the child Include and then its parent.
5. Start the application and confirm that no `entry id must not contain ":"` errors are logged and that runtime edits appear in the configuration file after `flush()`.
