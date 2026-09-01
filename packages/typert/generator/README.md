---
description: "The build-time Typert generator: source type analysis, compiler-independent models, and artifact emission for maintainers wiring Typert publication or consuming generated artifacts."
kind: "package-library"
---

# @deepseek-ai/dsh-typert-generator

English | [中文](README.zh.md)

## Summary

`dsh-typert-generator` turns source TypeScript into compiler-independent data and runnable artifacts at build time: it analyzes a workspace's package type trees, produces a `FaceModel` and type graph, and emits executable JavaScript with supported Zod schemas and a `TYPERT` reflection contribution, plus matching declarations. It is a build-time library, not a plugin — it never runs inside a live agent session. The repository's Host tsdown runs it automatically; a business package opts in by exporting `./typert` and `./client/typert` entries, and the generator validates those exports and published file lists. Static consumers can also call the analyzer directly for type inspection or catalog generation without publishing anything.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package is for package and repository maintainers who wire Typert generation into a build or consume generated artifacts. Publication is opt-in: declare the export entries, run the build, and the artifacts appear in `lib/`; static analysis needs no artifact.

### Publishing Typert artifacts from a package

A contributing package declares the host-face artifact export in `package.json`; packages that contribute both faces also declare `./client/typert`, and packages with Remote methods declare `./remote`:

```yaml
exports:
  "./typert":
    types: "./lib/typert.host.d.ts"
    default: "./lib/typert.host.js"
files:
  - "lib/typert.host.js"
  - "lib/typert.host.d.ts"
```

After the build, `lib/typert.host.js` and `lib/typert.host.d.ts` exist and the [loader](../loader/README.md) registers the contribution in Loader compositions. The generated declaration file exposes `TYPERT` as `unknown`, so contributing packages never depend on the runtime registry. The generator fails the build when a declaration is missing, points at the wrong file, or publishes Remote artifacts without Remote methods; unsupported Zod projections fail with a `TypertEmitError` naming the construct instead of flattening or weakening the source type.

### Analyzing a workspace statically

Static consumers call `WorkspaceAnalyzer` directly against the workspace's `tsconfig.host.json` and `tsconfig.client.json` aggregates, select a face and package subset, and read the resulting `FaceModel` and type graph without emitting or loading runtime artifacts. `analyzeInBatches()` processes a large package selection through bounded compiler programs with the same model shape, and `discoverPackages()` finds contributing packages without building a type-checker program.

### Running generation inside a tsdown build

The package's `./tsdown` subpath provides `typertPlugin()` for the root tsdown config: it lowers standard decorators in TypeScript dependencies before bundling and emits the model-driven face artifacts at the package output root. In `package` mode it emits only the bundled package; in `workspace` mode it emits every explicit contributor once.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the generator reaches a compiler-independent model and what it emits; the observable build behavior is covered in [Use this package](#use-this-package).

### Design concept

The generator is built on one separation: extraction and emission are decoupled through the compiler-independent model. `WorkspaceAnalyzer` reads TypeScript programs seeded from the face aggregate tsconfigs and produces `FaceModel` and `TypeGraph` data; `FaceModelEmitter` consumes only that model and never receives compiler nodes. The model retains declaration identity, generic parameters and applications, explicit inheritance, conditional and mapped types, import attributes, abstract modifiers, and source JSDoc, and excludes constructors, static members, and non-public members.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Public API: analyzer, emitter, workspace generator, renderer, catalog projection |
| [`src/analyzer.ts`](src/analyzer.ts) | `WorkspaceAnalyzer`: face programs, check/write modes, batching, discovery, source index |
| [`src/model.ts`](src/model.ts) | Compiler-independent model types |
| [`src/emitter.ts`](src/emitter.ts) | `FaceModelEmitter`: Zod schema and declaration emission, Remote declarations |
| [`src/workspace.ts`](src/workspace.ts) | `WorkspaceTypertGenerator`: discovery, generation, export and files validation |
| [`src/tsdown-plugin.ts`](src/tsdown-plugin.ts) | tsdown plugin face: decorator lowering and artifact emission |
| [`src/cordis-catalog.ts`](src/cordis-catalog.ts) | Catalog projection used by the generated Cordis catalogs |

### Analysis and faces

Host and client are independent TypeScript programs. Direct project references establish compiler-face membership, while `dsh.client` package subpaths establish runtime-face contribution; `package.json#exports` marks every cross-package public boundary, and imports or re-exports are the only cross-face edges. `check` mode fails on syntax or semantic diagnostics, missing public annotations, private cross-package references, and reachable declaration merges the model cannot retain losslessly; `write` mode inserts checker-derived annotations and returns a clean check-mode model. Types owned by NPM dependencies remain `external` references instead of being expanded.

### Emission and publication contract

`FaceModelEmitter` emits executable JavaScript containing supported Zod schemas and the `TYPERT` contribution, plus a declaration file whose schemas are typed `z.ZodType<SourceType>` through the package's public export; unsupported Zod projections fail. The Host face with Remote methods additionally emits `typert.remote-client.*` projections of Host Remote contracts for the Client. `WorkspaceTypertGenerator` validates each contributor's `package.json`: `./typert` and `./client/typert` (and `./remote` when Remote methods exist) must point at the exact generated files, and the `files` list must include them.

### Catalog projection

The root export includes the model-driven extraction, completeness checks, and deterministic text renderers used by this repository's Cordis catalogs. They accept a `CordisCatalogPolicy`; repository-owned type links, foundation and exemption classifications, and inherited Cordis entries stay in `scripts/gen-cordis-catalog.ts` and are passed in explicitly, so this package contains projection mechanics, not a hidden copy of the repository's documentation taxonomy.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the generated model to the runtime and the Remote-call path.

- [Typert subsystem reference](../../../docs/subsystems/typert.md) — the Remote contracts and registry interfaces the generator models.
- [Typert protocol](../protocol/README.md) — the declarations generated artifacts extend and consume.
- [Typert registry](../registry/README.md) — the runtime store the emitted artifacts feed.
- [API Gateway reference](../../../docs/api-gateway.md) — how generated Remote descriptors are invoked end to end.
- [Compiler-independent model Agent Note](../../../.agents/notes/implemented/architecture/2026-07-27-compiler-independent-typert-model.md) — the model design, alternatives, and consequences.

-----

<a id="model-experience"></a>
## Model Experience

None, as the build-time generator runs outside any agent runtime and touches no model request.

#### KV Cache effect

No direct effect; generated artifacts reach a request only when a consumer places them in one.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the generator cannot model or emit; they are current package constraints, not a task backlog.

- **Package export patterns are skipped** — contributing packages need concrete export targets; wildcard export patterns are not analyzed.
- **Namespace re-exports across faces fail** — named and star re-exports produce links, but a namespace re-export cannot be represented until `TypeTargetModel` can model a module namespace without flattening it.
- **The Zod emitter supports a deliberate subset** — generic schema declarations and computed constructs such as conditional or mapped schema roots fail until a concrete schema-factory policy exists.
- **No generated schema imports across faces** — cross-face links are represented for analysis, but no generated schema requires a runtime cross-face Zod import.
- **Discovery covers concrete public exports only** — declarations neither exported nor imported by the reachable graph are intentionally outside the package model.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This source-project analyzer and build-time emitter runs outside any cordis runtime; model snapshots, executable artifacts, and consuming-package typechecks enforce its output contract.
