---
kind: upgrade-guide
description: "ProfileContext replaces parsed overlays with overlay file paths that every composition rereads."
---

# Read command-line overlays from their files

English | [中文](guide.zh.md)

## Change

`ProfileContext` from `@deepseek-ai/dsh-app-boot`, provided as `ctx.profileContext`, no longer has `overlays: readonly PatchOptions[]`. It now carries `overlayPaths: readonly string[]`: the absolute `--patch` file paths in argv order. `readProfilePatches()` reads those files on each call, so it returns current overlay contents and throws while an overlay file is missing or invalid. With `dsh-hmr` enabled, editing a `--patch` file recomposes the running profile. Plugins that read `profileContext.overlays` and launchers or tests that construct a `ProfileContext` are affected.

## Migration

1. Replace reads of `ctx.profileContext.overlays` with `ctx.profileContext.overlayPaths.flatMap(path => loadOverlayPatches(binName, path))`, which returns the same overlay layer. Call `readProfilePatches(binName, ctx.profileContext)` only when you need the full composition of bundle, profile, home, and overlay layers.
2. Where code constructs a `ProfileContext`, replace `overlays: [...]` with `overlayPaths: [...]`. Write any in-memory overlay rows to a patch file first and pass its absolute path.
3. Confirm the migration by running your type checker: no `overlays` property remains on `ProfileContext` values.
