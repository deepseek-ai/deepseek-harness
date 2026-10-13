---
description: "The build-time Typert generator: source type analysis, compiler-independent models, and artifact emission for maintainers wiring Typert publication or consuming generated artifacts."
kind: "package-library"
---

# @deepseek-ai/dsh-typert-generator

English | [中文](README.zh.md)

## Summary

`dsh-typert-generator` lets maintainers turn public TypeScript types into build artifacts and compiler-independent models. Packages opt in through the `./typert` and optional `./client/typert` exports, and generation rejects declarations, publish lists, Remote exports, or Zod projections that it cannot represent correctly. Repository builds emit executable schema factories and matching declarations, while tools can call `WorkspaceAnalyzer` for inspection or catalog generation without publishing artifacts. Generation runs only at build time and never in a live agent session.

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

<a id="ordinary-remote-metadata"></a>
### Ordinary Remote metadata

The emitter writes one static `TypertRemoteMethodSpec` per endpoint and calls the pure `createTypertRemoteInfo` factory with the spec and the artifact's own imported Zod runtime. Ordinary consumer `./remote` artifacts retain their default export and `TYPERT_REMOTE`, typed as `TypertRemoteInfo` with precise `TypertRemoteMethod<Input, Output, Mode, Uplink, DecodedOutput>` entries in `TYPERT_REMOTE.methods`. Each entry is the same object as its direct descriptor in `TYPERT_REMOTE.descriptors`; Context-only receivers remain in descriptors and scoped declarations. There is no separate `REMOTE_METHODS` export, nested `metadata`, or second `output` codec. The [protocol](<../protocol/README.md>) owns the factory and method API.

The factory returns a class instance that retains the spec until its `descriptors` or `methods` getter builds their shared index. Each consumer-selected input-policy view, parser, and projection is independently lazy and cached, and generated individual Zod factories also materialize and cache on first use. Ordinary Host `./typert` builds a private info instance whose descriptors are exposed by the `TYPERT.invocations` getter. Host and consumer artifacts share definitions, not object identity across Programs or processes.

Generated declarations use type-only imports for owner and schema types. Importing metadata neither activates the Host Service nor opens a network connection. Framework consumers query the existing [registry](<../registry/README.md>); standalone consumers can import `./remote` directly. Source compositions requiring strict validation prebuild ordinary artifacts and register `./typert` through the [loader](<../loader/README.md>); descriptor-free source discovery cannot recover erased type constraints, documentation, or schemas.

Missing JSDoc and unsupported tool JSON Schema do not block otherwise valid ordinary generation or its strict codecs. Metadata retains parsers and available documentation independently of projection: each unsupported input variant or output projection omits `jsonSchema` and records its own `jsonSchemaError`. A tool consumer explicitly selects methods and requires its documentation and supported input schema; an output parser is required, but output JSON Schema is optional unless that consumer requires it. Metadata alone does not make every Remote method a tool.

Every generated parameter spec contains both `codec` and `strictCodec`, derived from the same checker-resolved type model; the analyzer and model carry no per-method input policy. `method.input()` and `{ strict: false }` select the normal codec used by Host dispatch, whose declared objects accept and strip unknown fields. `method.input({ strict: true })` selects recursively closed declared objects for both parsing and supported JSON Schema. Both named-argument envelopes reject extra arguments; explicit JSON and dictionary keys remain open, while constrained dictionary values also validate named fields against their index value type. Strict parsing distributes named-field and index-value unions before merging and closing each supported object combination, including optional fields and nullable index values. `result` keeps its single normal codec. Tool projection targets the tool-schema subset that [`@deepseek-ai/dsh-tools`](../../core/tools/src/json-schema.ts) enforces on tool parameters, tool output, and the generated PTC SDK; it supports scalars, objects, arrays, and disjoint unions, while canonical `JsonValue` and string-keyed JSON dictionaries need no recursive references. A type outside that subset is reported instead of projected more weakly. Numeric bounds and other semantic rules absent from TypeScript remain with the owning operation.

`WorkspaceTypertGenerator` analyzes all contributors of each selected face before filtering emitted packages, so a package subset retains the same declaration merges and output bytes as a complete build.

### Analyzing a workspace statically

Static consumers call `WorkspaceAnalyzer` directly against the workspace's `tsconfig.host.json` and `tsconfig.client.json` aggregates, select a face and package subset, and read the resulting `FaceModel` and type graph without emitting or loading runtime artifacts. `analyzeInBatches()` processes a large package selection through bounded compiler programs with the same model shape, and `discoverPackages()` finds contributing packages without building a type-checker program; its optional `package.json` predicate skips a package before its sources or project config are read. Typert parses only the tsconfigs of packages it analyzes; validating every referenced tsconfig belongs to the preceding `tsc -b`.

JSON, YAML, SVG, PNG, JPEG, and WebP resource exports contribute no TypeScript declarations and are excluded from the API model. Missing JavaScript or TypeScript export sources remain errors.

### Running generation inside a tsdown build

The package's `./tsdown` subpath provides `typertPlugin()` for the root tsdown config: it lowers standard decorators in TypeScript dependencies before bundling and emits the model-driven face artifacts at the package output root. A module-id filter on its `transform` hook keeps non-TypeScript modules out of JavaScript. The workspace root is the nearest ancestor of the bundle that contains both `tsconfig.host.json` and `packages/`, so a package's own face leaf config never qualifies. In `package` mode it generates synchronously in the bundled package's `writeBundle` and emits only that package.

In `workspace` mode it emits every explicit contributor once without blocking bundling: the first package build's `buildStart` starts generation in a Worker Thread, and the first `writeBundle` awaits the result and writes every artifact while later bundles return immediately. An analysis error, a worker crash or early exit, or a malformed worker response fails that bundle, and therefore the tsdown pass, with a `TypertWorkerError` naming the workspace and cause; the worker is terminated before the failure is reported.

### Generating without a bundler

`writeWorkspaceArtifacts()` and `writePackageArtifacts()` are the plugin's file writers: each artifact becomes `lib/typert.<face>.{js,d.ts}`, plus `lib/typert.remote-client.{js,d.ts,d.ts.map}` when it carries Remote methods, and a Host artifact without Remote methods removes stale Remote client files. Writing the result of `WorkspaceTypertGenerator.generateContributors()` through them leaves the same bytes as the `workspace`-mode plugin, and `findWorkspaceRoot()` applies the plugin's workspace-root rule. The repository's bundle-free pass, [`scripts/generate-typert.ts`](../../../scripts/generate-typert.ts), generates the Host face this way for type checks that need no bundle.

With `rejectBuildOutputs: true`, analysis fails with a `TypertAnalysisError` when a face program loads a file from a workspace package's `lib/` directory, or cannot resolve an import of a workspace package, as on a tree whose packages are not yet compiled. The error names each such import specifier and the source file a `paths` alias should map it to, so a passing generation depends only on workspace source and can run before or beside package compilation. Leave it off for a face whose sources import generated outputs, such as a Client face importing `/remote`.

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
| [`src/workspace.ts`](src/workspace.ts) | `WorkspaceTypertGenerator`: discovery, generation, export and files validation; workspace-root lookup |
| [`src/tsdown-plugin.ts`](src/tsdown-plugin.ts) | tsdown plugin face: decorator lowering and artifact emission |
| [`src/artifact-files.ts`](src/artifact-files.ts) | Package-local artifact writers shared by the plugin and bundle-free generation |
| [`src/build-output-guard.ts`](src/build-output-guard.ts) | Detection of workspace `lib/` files and unresolved workspace imports in a face program for `rejectBuildOutputs` |
| [`src/worker.ts`](src/worker.ts) | Worker Thread entry for workspace-mode generation |
| [`src/cordis-catalog.ts`](src/cordis-catalog.ts) | Catalog projection used by the generated Cordis catalogs |

### Analysis and faces

Host and Client are independent TypeScript programs. Direct project references establish compiler-face membership, while `dsh.client` package subpaths establish runtime-face contribution; `package.json#exports` marks every cross-package public boundary, and imports or re-exports are the only cross-face edges. A relative import that resolves inside the referencing package is followed through that module's re-exports until a package specifier appears, so package-local forwarding modules keep their original declaration references; a relative import that resolves into another package fails. `check` mode fails on syntax or semantic diagnostics, missing public annotations, private cross-package references, and reachable declaration merges the model cannot retain losslessly; `write` mode inserts checker-derived annotations and returns a clean check-mode model. Types owned by NPM dependencies remain `external` references instead of being expanded. A stream method's return type may be `Iterable<Out>`, `AsyncIterable<Out>`, or the protocol's `RemoteStream<Out, In>`, recognized by symbol and declaring package like the standard-library wrappers; a second type argument other than `never` yields the descriptor's uplink codec, and the generated Client signature returns `RemoteStreamHandle<Out, In>`.

### Emission and publication contract

`FaceModelEmitter` emits executable JavaScript containing success-cached Zod schema factories and the `TYPERT` contribution, plus a declaration file whose factories return `z.ZodType<SourceType>` through the package's public export; unsupported Zod projections fail. The Host face with Remote methods additionally emits `typert.remote-client.*` projections of Host Remote contracts for the Client. `WorkspaceTypertGenerator` validates each contributor's `package.json`: `./typert` and `./client/typert` (and `./remote` when Remote methods exist) must point at the exact generated files, and the `files` list must include them.

[Unary binary results](../protocol/README.md) are recognized after generic type resolution. Their codecs validate the byte-array type and JSON metadata without iterating, copying, or freezing the byte payload; generated Client declarations retain the authored metadata and narrow the byte backing to `ArrayBuffer`.

### Catalog projection

The runtime type closure indexes exported workspace declarations and referenced framework enums. Vendored declarations stay outside business API discovery; their enums remain available when a public result refers to them.

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
- **Strict indexed object merging has limits** — named-field and index-value unions are combined branch by branch when their object members are concrete properties. Recursive references, nested index signatures, and computed members retain separate schema intersections; strict parsing can reject otherwise valid values whose fields come from different operands.
- **No generated schema imports across faces** — cross-face links are represented for analysis, but no generated schema requires a runtime cross-face Zod import.
- **Discovery covers concrete public exports only** — declarations neither exported nor imported by the reachable graph are intentionally outside the package model.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
