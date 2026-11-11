---
kind: upgrade-guide
description: "Update direct dependencies and configuration overrides for the renamed macOS Computer Use provider."
---

# macOS Computer Use provider name

English | [中文](guide.zh.md)

## Change

The macOS provider package is now `@deepseek-ai/dsh-cua-macos` and its Cordis plugin name is `cua-macos`. The Computer Use bundle mounts it under the entry ID `cua-macos`. A profile that only enables the bundle picks up the new package automatically.

## Migration

1. Replace direct dependencies and imports of `@deepseek-ai/dsh-experimental-cua-macos` with `@deepseek-ai/dsh-cua-macos` and update your lockfile. In custom Cordis compositions, update the provider's `name` if it references the old package.
2. In home or profile `cordis.patch.yml` and other overlays targeting the bundled provider, change `id: cua` to `id: cua-macos`. Keep the whole existing `config`, including any `agentPreset`, `helperPath` or `sourceSigning` values. Independently chosen IDs in custom compositions can stay as configured.
3. On macOS with Computer Use enabled, run `dsh --profile web --dump-config` (substitute your profile). Check that the `cua-macos` entry loads the new package and has your expected configuration.
