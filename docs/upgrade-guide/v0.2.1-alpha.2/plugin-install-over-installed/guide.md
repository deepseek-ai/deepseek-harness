---
kind: upgrade-guide
description: "With HMR, installing a package that is already installed fails with already-installed; an upgrade removes the package first."
---

# Installing over an installed plugin package is refused with HMR

English | [中文](guide.zh.md)

## Change

In a profile that runs HMR, which the shipped profiles do, `pluginManager.installBundle(spec)` used to run pnpm over a package the profile already depends on and report `restart-required` while the previous version kept running. It now fails before pnpm runs, with `application: 'failed'` and `error.code: 'already-installed'`, and changes no profile file, when the spec names an installed package: a registry name with or without a version, a local directory, or the git or tarball spec the dependency was saved with. Repeating an installation of the same spec fails the same way instead of reporting `changed: false`.

This affects callers of `installBundle()` through the Host API and the remote client in `@deepseek-ai/dsh-api-remotes/client`, and the agent's `plugin_manager` tool (`install_bundle`). An installed package that cannot be removed, such as a bundle carrying plugin management, can no longer be installed over while HMR runs. The Web page's Update for an Official plugin removes the package and installs the new version itself. Without HMR, installing over an installed package still runs pnpm and reports `restart-required`.

## Migration

1. To install another version or location of an installed package, call `removeBundle(name)` first, then `installBundle(spec)`. For the agent tool, call `remove_bundle`, then `install_bundle`. The removal stops the bundle's plugins and drops its packages' mappings, so the new version is mapped afresh and starts without a restart.
2. If code switches exhaustively over `ManagementError['code']`, handle the `already-installed` code.
3. Confirm the migration: installing the package again returns `already-installed`, and after `removeBundle` the same `installBundle` call returns `applied` with the new `version`.
