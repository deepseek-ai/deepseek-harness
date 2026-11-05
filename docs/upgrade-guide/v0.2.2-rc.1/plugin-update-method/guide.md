---
kind: upgrade-guide
description: "BundleInfo.updatable is replaced by BundleInfo.update, and ManagementError gains the unexpected-package code."
---

# `BundleInfo.update` replaces `BundleInfo.updatable`

English | [中文](guide.zh.md)

## Change

`pluginManager.listBundles()` no longer returns `BundleInfo.updatable: boolean`. It returns the optional `BundleInfo.update`, which is `'registry'` for a bundle whose newer versions `listVersions` reads, `'git'` for a bundle installed from a Git spec pinned to a full commit, and absent for a bundle `updateBundle` cannot replace. A bundle that `updatable: true` marked before is now `update: 'registry'`. `updateBundle` also accepts a `'git'` bundle when `options.spec` names a newer commit of the same repository directory.

`ManagementError['code']` gains `unexpected-package`: an installation run with `InstallBundleOptions.expected`, which `updateBundle` always passes, fails with it when the spec installs another package or version.

This affects code that reads `listBundles()` through the Host API, `@deepseek-ai/dsh-plugin-manager/types`, or the remote client in `@deepseek-ai/dsh-api-remotes/client`, and code that switches exhaustively over `ManagementError['code']`. The `plugin_manager` tool never returned the field and is unchanged.

## Migration

1. Replace each read of `updatable`. To decide whether `listVersions` can list a bundle's versions, test `bundle.update === 'registry'`; to decide whether `updateBundle` can replace it at all, test `bundle.update !== undefined`.
2. If code switches exhaustively over `ManagementError['code']`, handle `unexpected-package`.
3. Run your type check; it succeeds when no `updatable` read and no unhandled `ManagementError` code remains.
