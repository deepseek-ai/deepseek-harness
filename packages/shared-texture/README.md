---
description: "Shared-texture capability seam: the abstract Host Cordis service, the Client plugin that provides the renderer bridge, and bridge types."
kind: "package-group"
---

# packages/shared-texture

English | [中文](README.zh.md)

## Summary

Shared textures transfer GPU-backed frames from a Host process to its presentation document without copying pixels through JavaScript. This group defines the abstract Host `ctx.sharedTexture` service, the Client plugin that provides the renderer bridge as the Client `ctx.sharedTexture`, and the pure renderer bridge types shared across Host, preload, and browser plugins.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`shared-texture`](shared-texture/README.md) | Abstract Host shared-texture service, Client bridge plugin, and renderer bridge types | `ctx.sharedTexture` |

<a id="related-documentation"></a>
## Related documentation

- [Shared textures](../../docs/subsystems/shared-texture.md) — Host claim lifecycle, renderer bridge types, and Cordis API.
- [Desktop application](../../apps/desktop/README.md) — Electron transport, native addons, and preload bridge.

<a id="dev-note"></a>
## Dev Note

None.
