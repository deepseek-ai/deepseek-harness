---
kind: upgrade-guide
description: "Plugin compatibility checks read engines.dsh before DSH peerDependencies, and refusals report requirements instead of peers."
---

# Plugin compatibility reads `engines.dsh` first

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.3, installation and profile startup judged a plugin or bundle only by its `peerDependencies` on `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`, and ignored `engines.dsh`. In the next release, an own `engines.dsh` range decides alone and those peers are ignored; the peer rule applies only when `engines.dsh` is absent. `workspace:` values are valid only in peers; in `engines.dsh` they are incompatible. A non-object `engines` or a non-string `engines.dsh` makes the manifest unreadable for compatibility, which refuses the package. Plugin authors whose package declares `engines.dsh`, or declares `engines` as something other than an object, are affected.

The `incompatible-version` refusal record that the plugin manager returns to clients, `IncompatiblePlugin`, and the app-boot `PluginCompatibility` result rename `peers` to `requirements`. Keys are `engines.dsh` for the engines rule or the peer package name for the fallback. Code that reads these records is affected.

## Migration

1. If your package declares `engines.dsh`, make that range cover every DSH release the package supports, because DSH peer ranges no longer widen or narrow it. Remove `engines.dsh` to keep peer-based checking.
2. Replace `workspace:` values in `engines.dsh` with a semantic version range.
3. Read `requirements` instead of `peers` from `IncompatiblePlugin` and `PluginCompatibility`.
4. Confirm by installing the package with `dsh plugin --profile <profile> add <package@version>` or the plugin manager: a mismatch names `engines.dsh` or the peer package in the refusal.
