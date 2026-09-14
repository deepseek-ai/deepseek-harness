---
description: "Computer-use capability packages for selecting and registering one desktop provider."
kind: "package-group"
---

# packages/computer-use

English | [中文](README.zh.md)

## Summary

Computer-use providers let models observe and operate a desktop. This group owns exclusive provider registration. Each provider owns its operations, tools, and platform requirements; the experimental Cua Driver providers live in the experimental group.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Choose one provider and mount the shared registration service.

| Package | Role | ctx key |
|---|---|---|
| [`computer-use`](computer-use/README.md) | Exclusive named provider registration | `ctx.computerUse` |

<a id="related-documentation"></a>
## Related documentation

- [Computer use](../../docs/subsystems/computer-use.md) — capability ownership and provider choices.
- [Experimental packages](../experimental/README.md) — Cua Driver MCP and native providers.

<a id="dev-note"></a>
## Dev Note

None.
