---
description: "The Typert group map: the build-time type-graph generator, runtime registry, Loader integration, and shared Remote protocol that enable typed Host-to-Client calls."
kind: "package-group"
---

# packages/typert

English | [中文](README.zh.md)

## Summary

With the Typert group, Client environments can call Host capabilities as typed methods and share generated schemas and reflection without hand-written wire code. A build-time generator turns source type declarations into compiler-independent models and runtime artifacts, a runtime registry stores those artifacts, and a Loader integration registers them automatically in Loader compositions. A shared protocol package supplies the Remote-call declarations — decorators, wire descriptors, codecs, and provider contracts — that business packages, generated artifacts, the Host Gateway, and the Client API all consume. This page maps the four packages; each package README owns its configuration, usage, and limits.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`generator/`](generator/README.md) | Analyzes source types at build time and generates the reflection, schemas, and Remote descriptors that runtimes load | — |
| [`loader/`](loader/README.md) | Auto-registers generated Typert artifacts from Loader compositions into the runtime registry | consumes `ctx.loader` and `ctx.typert` |
| [`protocol/`](protocol/README.md) | Declares the Remote decorators, wire descriptors, codecs, and provider contracts shared by Host and Client | — |
| [`registry/`](registry/README.md) | Stores generated package reflection and live Zod schemas at runtime, plus lookup and Context provider registries | `ctx.typert` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Typert subsystem reference](../../docs/subsystems/typert.md) — the literal public contracts recorded from protocol and registry types.
- [API Gateway reference](../../docs/api-gateway.md) — how the generated Remote descriptors become running Host-to-Client calls.
- [Remote-call Agent Note](../../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.md) — the architecture and transport decisions behind Remote calls.
- [Package workspace map](../README.md) — every group in the workspace and what each owns.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
