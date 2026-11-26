# Agent Note: Package-local chunk dependencies

Status: implemented

English | [中文](2026-11-26-package-local-chunk-dependencies.zh.md)

## Problem

The dynamic Client preset builds a package's browser half with Rolldown, which splits every source `import()` into a `client.<name>.js` chunk. Rolldown also moves code that several chunks share, including its CommonJS helper `\0rolldown/runtime.js`, into common chunks, and every chunk that uses them requires those chunks synchronously. The [loading model](2026-07-23-client-plugin-loading-model.md) required self-contained output: a factory's `require` answered only module-table requests, and `require.async` loaded exactly one chunk. A package whose lazy modules import each other, such as syntax grammars that embed other grammars, could not split by `import()`, and an entry that shared one module with a lazy chunk failed at runtime on its synchronous `require("./client.<name>.js")`.

## Decision

Chunks of one package may require each other synchronously. Two `deps` lists carry the chunk graph to the [module system](../../../../packages/client/modules/README.md), each with its own obligation:

- **Registration `deps`** in `__ModuleLoader__.load({ id, chunk, deps, factory })` is a precondition: the chunks of the same package (`./client.<name>.js`) that the factory requires synchronously. The module system downloads and registers each of them, and transitively their own `deps`, before the factory runs. The [preset](../../../../packages/client/tsdown.client.ts) writes the chunk's direct chunk imports from Rolldown's `RenderedChunk.imports` and omits the field when there are none.
- **`require.async(spec, { deps })`** is a prefetch hint: further chunks of the same package to download in parallel with the requested chunk. The preset writes the requested chunk's transitive synchronous closure, computed from the `meta.chunks` graph of `renderChunk`, minus the chunks the entry file carries, and keeps the one-argument call when nothing remains. A missing hint costs round trips only, because registration `deps` still load the group one level per round. A request for another package ignores the option.

The preset moves every chunk the entry requires synchronously, transitively and dependencies first, into the entry file ahead of the entry's own registration, and deletes their files and maps. One script may already register several factories, as combo batches do, so the entry needs no request beyond its own script. The move runs in `generateBundle` after input isolation has checked each chunk, and the entry map gains one empty line per inserted line, in both the emitted map asset and the in-memory chunk map. A chunk that imports the package entry, statically or dynamically, fails the build: the module system keys the entry by package id, so no relative specifier reaches it. A dynamic import of a chunk the entry file carries keeps Rolldown's synchronous `require` inside a resolved promise, because the entry file registers that chunk before any code of the package runs and no file is left to download.

In the module system, a synchronous `require("./client.<name>.js")` materializes a registered chunk of the same package and throws for an unregistered one. Arriving a graph row registers its entry script, then the entry's registration `deps`; a batch script can register the entry without the row's own download, so the dependency step also runs for an entry that was already registered, and an owner invalidation while those chunks download restarts the arrival from the entry script. A package-local `require.async` downloads the hinted chunks in parallel with the requested chunk and waits for those downloads to end before the chunk runs or the request retries, so a hinted download of a dropped generation cannot discard what the retry registers; the chunk itself needs only its registration `deps`, transitively and in parallel, and a hinted chunk that fails to download fails the request only through a registration that requires it. A failed dependency rejects with the chain of registrations that required it, with or without a hint, once every sibling arrival has ended; an owner invalidation during arrival restarts the request under the new revision; a cycle downloads once and fails when the factories run, as module-table cycles do. A `deps` entry that names no package-local chunk is rejected at registration and at the request.

[`src/chunks.ts`](../../../../packages/client/modules/src/chunks.ts) owns the chunk file-name pattern that the preset, the Host chunk route, the module system, and the WebWorker packer read. The publication closure check in [`publint-all`](../../../../scripts/publint-all.ts) accepts a `require("./client.<name>.js")` inside a registered module factory whose file is not published when a script in the same directory registers the package entry and that chunk, because the moved chunks no longer have files; an ESM `import` or any other relative request still needs its published file. The WebWorker packer treats hinted chunks as requested ones, so they leave the base image as well. Values of another package remain module-table requests composed by the Host graph; `deps` never names another package.

## Alternatives considered

**Self-contained chunks through Rolldown's chunking options.** Forcing shared modules into each importing chunk gives every chunk a private copy of each module it reaches. Grammar modules form a graph, so the copies multiply, and modules with state would exist once per chunk.

**Rolldown groups that keep the entry's shared modules in the entry chunk.** Lazy chunks would then require `./client.js`, which the module system does not address, and the group rule would duplicate Rolldown's reachability analysis. Concatenating the rendered chunks keeps Rolldown's chunk graph and every registration unchanged and costs one source-map offset.

**Separate files for the entry's chunks, loaded through registration `deps`.** Every package with shared code would add at least one request round before its entry can run during boot.

**One `deps` list with both meanings.** A hint that the loader trusted would turn a builder's closure mistake into a missing chunk at runtime, and a precondition that the loader treated as a hint would run a factory whose dependencies never arrived when no hint accompanies the request, as when one chunk requests another.

**Waiting for dependencies inside `require`.** A factory's `require` is synchronous; factory-form CommonJS cannot wait, so every chunk a factory requires must be registered before it runs.

## Consequences

- A hinted lazy group downloads in one round; registration `deps` alone take one round per dependency level.
- The entry file grows by the moved chunks. Boot only registers them; their factories still run at the first `require`.
- The moved chunks have no source mapping in the entry map, so browser tools show their generated code.
- During HMR replacement, old code that requests a chunk after its package was invalidated loads the new revision's chunk. If that chunk requires a chunk the new entry file carries, the request fails until the new entry has registered; the loader does not handle chunks specially for HMR.
- A package built outside this repository must write registration `deps` for every synchronous chunk require; the hint is optional.

## Testing

- [chunk-deps.client.spec.ts](../../../../packages/client/modules/tests/chunk-deps.client.spec.ts) covers level-by-level arrival, one-round hinted downloads, entry dependencies registered by the same script or completed after a preloaded registration, an entry arrival restarted by an invalidation during its chunk downloads, shared and cyclic dependencies, the failure chain with and without a hint, a failed hinted chunk that no registration requires, restart after invalidation, a retry that waits for the hinted downloads of the dropped generation and for every sibling of a failed dependency, re-execution of an entry script after invalidation, rejected `deps` entries, and synchronous requests of unregistered chunks.
- [client-bundle-chunk-deps.client.spec.ts](../../../../scripts/client-bundle-chunk-deps.client.spec.ts) builds a fixture whose entry and lazy chunks share modules and CommonJS packages, asserts the moved registrations, deleted files, registration `deps`, hints, the synchronous form of a dynamic import of an entry-carried chunk, and the shifted map, rejects a chunk that imports the entry statically or dynamically, and runs the written artifacts through the real module system.
- [lazy-chunks.spec.ts](../../../../packages/experimental/webworker-packer/tests/lazy-chunks.spec.ts) moves hinted chunks out of the WebWorker base image.
- [publint-all.spec.ts](../../../../scripts/publint-all.spec.ts) accepts a factory's chunk request that the entry file registers and rejects one that only a chunk file registers, that nothing provides, or that an ESM import or code outside a factory makes.
