---
description: "The runtime-diagnostics group map: package-owned runtime invariant checks for live compositions, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/runtime-diagnostics

English | [中文](README.zh.md)

## Summary

The runtime-diagnostics group provides runtime self-checking for DeepSeek Harness compositions: one package, `invariants`, runs package-owned checks that verify each package's durable event and data relationships while the composition is live. A violation surfaces as an error attributed to the package that owns the relationship; a global switch and package-name filters control which checks run. Use this group's package when a composition should verify its own runtime contracts as part of normal operation.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`invariants`](invariants/README.md) | Runs package-owned runtime checks and reports each failure by owning package | registers on `ctx.invariants` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Runtime invariants subsystem](../../docs/subsystems/invariants.md) — the generated service reference: selection, installer, and companion contract.
- [Invariant runtime contracts Agent Note](../../.agents/notes/implemented/architecture/2026-07-19-package-invariant-runtime-contracts.md) — what a runtime invariant may assert and the mechanical gate enforcing companion wiring.
- [Package conventions](../AGENTS.md) — the `./invariant` companion rule every package follows.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
