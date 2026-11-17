---
description: "Computer-use capability packages for selecting and registering one desktop provider."
kind: "package-group"
---

# packages/computer-use

English | [中文](README.zh.md)

## Summary

Computer-use providers let models observe and operate a desktop. This group contains the shared registry that prevents multiple providers from being enabled in one composition. DSH's [CUA implementation](../experimental/cua/README.md), platform providers, and opt-in bundle currently live in `experimental`, alongside the Cua Driver adapters. The CUA package documents the platform requirements for promotion to this group.

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
- [Computer Use bundle](../experimental/cua-bundle/README.md) — enable native CUA and access its permission controls.
- [Experimental packages](../experimental/README.md) — native CUA packages and Cua Driver adapters.

<a id="dev-note"></a>
## Dev Note

None.
