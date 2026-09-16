# Agent Note: Compiler-independent Typert type model

Status: implemented

English | [中文](2026-07-27-compiler-independent-typert-model.zh.md)

## Problem

Constructing Zod and reflection text directly from the TypeScript AST couples type analysis and business-semantic recognition to a single generation target. Such a generator can answer only “can this syntax be generated?” It cannot provide a canonical representation of packages, faces, public exports, services, events, objects, and their type relationships, nor can static checks and later generation targets reuse it.

The host and client are independent TypeScript projects; placing both in one `ts.Program` merges conflicting Cordis `Context` and `Events` declarations. At the same time, client types still need to reference host types explicitly, so neither complete isolation nor duplicating types on both sides can express the actual dependencies.

## Decision

[`dsh-typert-generator`](../../../../packages/typert/generator/README.md) builds separate `ts.Program` instances from the host and client projects and uses compiler nodes, symbols, and checkers only as extraction tools. After analysis, every generator and scanner consumes only Typert's own `WorkspaceModel`, `FaceModel`, and `TypeGraph`; the model retains no AST or checker objects. The generator has no dependency on `@deepseek-ai/dsh-typert-registry`.

TypeGraph preserves the developer-authored, pre-evaluation type structure, including generic parameters and applications, explicit inheritance, conditional and mapped types, recursive references, and JSDoc. A reachable type that cannot be represented losslessly causes analysis to fail. If an emitter cannot handle an already modeled node, that emitter fails instead of flattening the type or degrading it to `unknown`.

Each face independently owns a PackageModel and TypeGraph. Direct project references from `tsconfig.host.json` and `tsconfig.client.json` determine a package's face membership, while `package.json#exports` defines its public boundary. Cross-face relationships come only from explicit imports or re-exports in source and remain separate links; external npm types are recorded as External without reading or copying their declarations.

PackageModel recognizes Cordis services, events, `@typert object` reference objects, and `@typert schema` data roots. Services and objects expose only public instance members, excluding constructors and static, private, and protected members; inheritance edges remain in TypeGraph instead of being copied into flattened members. When a public property, parameter, or return type lacks an annotation, `check` mode reports an error, while `write` mode writes the checker-inferred result, rebuilds the project, and analyzes it again in strict mode.

[`dsh-typert-registry`](../../../../packages/typert/registry/README.md) provides `ctx.typert` and handles runtime registration only: one contribution atomically carries package-face reflection and optional Zod schema factories, and Cordis effect disposal revokes it. The registry validates factories without invoking them, then materializes and caches each schema on its first `get()`, `resolve()`, `list()`, or JSON Schema projection. It neither analyzes TypeScript nor merges the two faces.

Package artifact publication remains explicit opt-in through package exports. When invoked, `WorkspaceTypertGenerator` validates that each requested host face exposes the user-facing subpath `package/typert` from the root artifact `package/lib/typert.host.{js,d.ts}`, or that each requested client face exposes `package/client/typert` from `package/lib/typert.client.{js,d.ts}`; it never edits those exports. The later [Typert Remote design](2026-08-02-typert-remote-method-calls.md) adds a whole-workspace Host contract pass to root build, typecheck, lint, and documentation typecheck. For opted-in Host packages, that pass emits both local reflection and strict Host-for-Client `/remote` contracts before consumers resolve them. Generated local declarations keep `TYPERT` typed as `unknown`, so business packages do not depend on the registry.

At build time, `CordisCatalogProjector` consumes the analyzed `FaceModel` and `TypeGraph` once to generate `docs/cordis-catalog/events.md`, `docs/cordis-catalog/services.md`, and the static `SERVICE_API`, `EVENT_API`, and `TYPE_API` catalog committed for `tool-cordis`. `tool-cordis` reads that static catalog and has no runtime dependency on `ctx.typert`. [`dsh-typert-loader`](../../../../packages/typert/loader/README.md) and the registry remain an independent runtime path: the loader follows Cordis Loader entry lifecycle events, imports an explicitly published `./typert` host artifact, and registers it through `ctx.typert`; neither component supplies the current `cordis_inspect` catalog.

## Verification contract

A small two-face project in the repository snapshots the complete type model, including its source declaration index. Batched workspace analysis and direct focused analysis must produce model-equivalent `FaceModel` and `TypeGraph` results for the same faces. Compile-time exhaustive maps and runtime set comparisons ensure that every node, target, declaration, and member discriminant is exercised by source-authored TypeScript syntax; a field-semantics matrix covers every keyword, type operator, and literal value category, plus every state of generics, parameters, tuples, mapped modifiers, import attributes, abstract forms, predicates, and enum initializers.

For every property in `SyntaxZoo`, the TypeScript printer normalizes the source type, which must exactly match the TypeGraph rendering; TypeScript then recompiles every rendered declaration. This layer checks that each node's internal information is preserved losslessly, including no-substitution template literals, type queries with type arguments, and constrained `infer`, without substituting discriminant coverage or code coverage for structural equivalence.

Boundary cases pin explicit package imports within and across faces, cross-face named re-exports, exact export aliases, qualified `import()` links, and the External classification of global `@types` declarations; they reject TypeScript diagnostics originating in package-owned files, relative-path boundary crossings, references outside `package.json#exports`, and cross-face namespace re-exports without a model target. Interface declaration merging explicitly preserves every authored part; other merges that cannot be represented losslessly fail.

For each supported node kind and literal category, Zod emitter tests run both successful and failing parses; for each unsupported kind, they assert an explicit `TypertEmitError`. Emitter fixtures snapshot generated Zod JavaScript and `.d.ts` text, execute each schema factory, and typecheck the declarations. `dsh-typert-registry` tests pin atomic registration, first-use materialization, successful-result caching, retry after factory failure, queries, JSON Schema, and effect disposal; `dsh-typert-loader` tests also prove delayed mounting, unloading, and disposal while a dynamic import remains pending. A real `dsh-tools` vertical slice generates a contribution from the model, loads it through the runtime registry, and compares its service, event, and related-type records with the committed static `SERVICE_API`, `EVENT_API`, and `TYPE_API`. A full-workspace projector test regenerates the two Cordis catalog documents and the `tool-cordis` API catalog and requires all three texts to be byte-for-byte identical to the committed artifacts.

## Alternatives considered

**Retain the TypeScript AST directly.** The AST preserves source syntax, but it would make every consumer depend on the compiler lifecycle, node identity, and checker context, preventing a stable architectural boundary. It is therefore used only during extraction.

**Generate final types from the checker.** A flattened `ts.Type` is easy to traverse directly, but it loses the developer's expression of generics, conditional and mapped types, and alias applications, so it cannot support reflection and later generation needs.

**Merge the host/client projects or duplicate host types.** Merging would contaminate Cordis declaration merging; duplication would create a second source of truth for types. Independent faces with explicit cross-face links preserve project isolation and actual reference relationships.

**Make `dsh-typert-registry` responsible for type resolution and cross-package composition.** That would recouple the TypeScript compiler, Cordis lifecycle, and a specific schema policy. The registry remains a lifecycle container for generated artifacts, while the build-time model retains complex analysis.

## Consequences

New generation targets and static checks can reuse the same TypeGraph, and business categories can extend PackageModel without parsing the AST again. Preserving pre-evaluation types and independent faces makes the model more complex than a flattened schema; emitters must explicitly declare their supported scope and fail on missing capabilities.

Explicit package opt-in keeps artifact publication and exports under package ownership. Repository orchestration may still run the whole-workspace Host contract pass for every opted-in package; that pass remains owned by the later Remote Gateway Agent Note. The static Cordis catalogs remain reproducible from the canonical model without coupling `tool-cordis` to runtime registry state. `ctx.typert` reflects only artifacts mounted in the current runtime, and unloading does not control Zod instances that consumers retain after materializing them.
