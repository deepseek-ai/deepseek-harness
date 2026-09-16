---
description: "The boot package group: how dsh app bins start — environment loading, profile and patch layers, clear startup failures, and app-owned command lines."
kind: "package-group"
---

# boot/ — shared app-bin boot glue

English | [中文](README.zh.md)

## Summary

The boot group launches profile applications and manages their installed composition. `app-boot` resolves configuration and starts the Loader, `cmdline` supplies application arguments, and `plugin-manager` exposes current-profile operations shared with the CLI. Each package README owns its details.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`app-boot`](app-boot/README.md) | Boots a dsh app from a `cordis.yml`: loads `.env`, applies profile and patch layers, and reports startup failures clearly | (library for the bins) |
| [`cmdline`](cmdline/README.md) | Lets the app own its flags, `--help`, and exit code; passes everything after the launcher's flags through verbatim | `cmdlineArgs`, `appExit` |
| [`hmr`](hmr/README.md) | Coordinates module and configuration reloads with package mutations | `hmr` |
| [`plugin-manager`](plugin-manager/README.md) | Manages current-profile plugins and bundle packages through shared CLI operations | `pluginManager` |

<a id="related-documentation"></a>
## Related documentation

- [dsh app](../../apps/cli/README.md) — the `dsh` bin that consumes these helpers for its boot sequence.
- [Profile bundles](../bundle/README.md) — installable patch layers that `dsh --profile` compositions mount.
- [dsh-home-paths](../util/home-paths/README.md) — the harness-home resolver both packages build on.
- [dsh-cmdline](cmdline/README.md) — how an app owns its flag family instead of the launcher.

- [Profile management](../../docs/subsystems/boot.md) — service methods and result records.

<a id="dev-note"></a>
## Dev Note

None.
