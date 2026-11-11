---
kind: upgrade-guide
description: "Update direct dependencies and configuration overrides for the renamed macOS Computer Use provider."
---

# macOS Computer Use provider name

English | [中文](guide.zh.md)

## Change

The Computer Use bundle picks up the renamed macOS provider automatically. Direct dependencies and overrides use the following names.

| Name | Previous | New |
|---|---|---|
| npm package | `@deepseek-ai/dsh-experimental-cua-macos` | `@deepseek-ai/dsh-cua-macos` |
| Cordis plugin | `experimental-cua-macos` | `cua-macos` |
| Bundle entry ID | `cua` | `cua-macos` |

## Migration

1. New versions are published under the new npm name. Update direct dependencies and imports to `@deepseek-ai/dsh-cua-macos` and refresh your lockfile. In custom Cordis compositions, update the provider's `name` if it references the old package.
2. In home or profile `cordis.patch.yml` and other overlays targeting the bundled provider, change `id: cua` to `id: cua-macos`. Keep the whole existing `config`, including any `agentPreset`, `helperPath` or `sourceSigning` values. If an overlay still targets the old bundle entry, `--dump-config` reports `patch: entry "cua" not found` and the Loader skips that override. Source builds then use the default ad-hoc signature unless another entry supplies `sourceSigning`. macOS may ask for permission again after the helper is rebuilt. Custom compositions can keep their own entry IDs.
3. On macOS with Computer Use enabled, run `dsh --profile web --dump-config` (substitute your profile). Check that the `cua-macos` entry loads the new package and has your expected configuration.
