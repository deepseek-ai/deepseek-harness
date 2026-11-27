# Agent Note: three Client packages as `immediately` dynamic plugins

Status: implemented

English | [中文](2026-11-27-client-packages-as-immediately-dynamic-plugins.zh.md)

> The [Client shell layering note](2026-08-15-client-shells-and-dynamic-packages.md) owns build forms, shared module requests, and dependency declarations for every Client package. This note owns why `ui-slots`, `ui-primitives`, and `ui-dockkit` are `immediately` dynamic plugin packages while `client-store` stays statically linked, the compatibility adjustments to their package root, which specifier names them, and the compatibility commitments to code outside the repository.

## Problem

`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, and `@deepseek-ai/dsh-client-ui-dockkit` supply synchronous values, such as slot registry types, shared controls, and the dock layout engine, to most Client bundles. The Web shell linked them statically, so the shell bundle carried them together with KaTeX, Shiki, and the Markdown parser, and the shell seeded their module-table identities.

A dynamic plugin package is a Loader row, and the Host Loader imports every row's package root in Node, where these packages' stylesheet imports cannot load. Published package `exports` can send the types and the runtime of the root to different files. In the repository, one tsconfig `paths` entry per name serves tsc, Vitest, and the tsx source launch alike, and it cannot.

## Decision

### `immediately` dynamic plugin packages

Each of the three packages declares `dsh.client` with `platform: 'web'` and `immediately: true`, as `ui-renderer`, `client-connection`, and the other `immediately` packages do, and [`packages/bundle/web-app/cordis.patch.yml`](../../../../packages/bundle/web-app/cordis.patch.yml) lists their rows by plain package name. `src/client/index.ts` builds `lib/client.js`, the `./client` export, whose `apply` registers nothing. The `immediately` tier registers these factories before other plugins materialize, so any bundle can require their exports, and every dynamic bundle leaves the three names to the module table without declaring them ([shared module table](../../../../packages/client/web/README.md#the-shared-module-table)).

They differ from the other `immediately` packages in two ways. Their package root carries the compatibility adjustments below. Their `/client` entries still export values, such as components, classes, and functions, that other bundles require; this is a historical exception that will be reduced over time and no precedent for new value exports ([export discipline](../../../../packages/client/AGENTS.md#export-discipline-client-plugin-packages)).

### `client-store` is a statically linked library

`@deepseek-ai/dsh-client-store` is a `staticLinked` library that the Web shell bundles with Zustand and Immer and seeds into the module table; repository code imports it by package root, and it imports no DSH package. `ui-slots` and `ui-primitives` import it by package root, and their dynamic bundles leave it to the module table like every other baseline module. A store service, if one is needed, is a new package, not a conversion of this one.

### The package root: a Host entry with the `./client` types

The root's runtime is the hand-written `src/index.js`, which exports only the empty `apply` and builds the Host entry `lib/index.js`; the packages have no `src/index.ts`. `tsconfig.base.json` maps each package root to the `src` directory, as for every Client package, so tsx resolves it to `src/index.js` and the Host Loader never evaluates `src/client/index.ts`. The packages have no Host API, so the published root `types` reuse `lib/types/client/index.d.ts`, the `./client` declarations, and [`check-workspace-constraints`](../../../../scripts/check-workspace-constraints.ts) accepts root types that equal the package's own `./client` types. Gates that need the Host source resolve `./src/index.js` to its source module.

### `X` and `X/client` name one module

The module table resolves a `<specifier>/client` it does not hold exactly to the `<specifier>` row ([`stripClientSuffix`](../../../../packages/client/modules/src/client/manifest.ts)), so `require('<package>')` and `require('<package>/client')` return one exports object. The dynamic build preset applies the same rule through `coversRequest` in [`tsdown.client.ts`](../../../../packages/client/tsdown.client.ts): when `<specifier>` is a baseline, preloaded, or `dsh.client.external` request, a bundle that imports `<specifier>/client` emits a module-table `require` instead of inlining a private copy.

### The repository names the packages through `/client`

Repository code imports values and types from, and augments, `<package>/client`; [`verify-client-packages`](../../../../scripts/verify-client-packages.ts) rejects every package-root reference to a workspace package whose root `types` equal its own `./client` types, a set it reads from the manifests. In the repository the package root resolves to the Host entry: Vite and Rolldown find `src/index.js`, so a root value import reads `undefined`, and the compiler finds no declarations there. Root declarations in the repository would need a separate file, and TypeScript merges a root augmentation and a `/client` augmentation of one interface only when it processes the `/client` one first. With `/client` everywhere, every augmentation lands on the module that declares the interface. The `/client` paths resolve to `src/client/index.ts` in every tool, so the Vitest lanes need no alias, and the benchmark workers bundle the `/client` subpaths of workspace packages that declare `dsh.client` from source ([`benchmarks/tsdown.config.ts`](../../../../benchmarks/tsdown.config.ts)).

`/client` is also the recommended specifier for every consumer.

### Compatibility commitments

Published packages give the root and `./client` one declaration file, so code outside the repository may use either spelling or mix them. DSH tests two commitments for code written against the package root:

| Commitment | Enforced by |
| --- | --- |
| A TypeScript consumer may import types from the package root, augment `declare module '<package>'`, and mix both spellings in one file or across files in either order; every importer reads one merged interface, under NodeNext and Bundler resolution | [`verify-client-package-consumer-types`](../../../../scripts/verify-client-package-consumer-types.ts) in `pnpm run hygiene`, compiling the [external consumer fixtures](../../../../scripts/fixtures/client-package-consumer/) against the built `lib/types`; its negative control requires the mixed programs to fail against a forwarding package root |
| A built plugin's `require('<package>')` returns the same exports as `require('<package>/client')` | [`loader.client.spec.ts`](../../../../packages/client/modules/tests/loader.client.spec.ts) and the browser test [`client-package-specifiers.e2e.ts`](../../../../apps/web/tests/client-package-specifiers.e2e.ts) with a hand-written prebuilt fixture plugin |

A dynamic bundle that imports either specifier emits a module-table `require` and inlines none of the three packages ([`client-bundle-purity.spec.ts`](../../../../scripts/client-bundle-purity.spec.ts)). Values from the package root in Node, the `__$dsh_client_module_manifest` export, and stability of the packages' exported APIs are not supported.

## Alternatives considered

**Change `apps/cli/src/bin.ts` or add a source-launch resolve hook.** The source launch would resolve these three names differently from tsc and Vitest, a rule that every launcher and tool would have to repeat.

**Change the Loader or the client-modules resolution.** The module table already answers package rows and their `/client` subpaths; a branch for three packages would make them a special kind of row.

**Name the rows by anything other than the plain package name.** Every other row uses its package name; renaming these rows would move the special case into every composition.

**Duplicate the tsconfig paths, mapping the root to `/client` for some tools and to the Host entry for others.** One `paths` table serves tsc, Vitest, and tsx, so a second mapping per name would need a separate configuration for each tool.

**Custom export conditions.** tsc, Vite, Rolldown, tsx, and Node would each have to opt in to the condition, and a consumer that does not would read the wrong file.

**File-existence checks for `.ts` versus `.js` in gates and tools.** Gates would pass or fail depending on which file a checkout contains; they name `./src/index.js` directly instead.

**A separate "platform library" category or variable.** The three packages are `immediately` dynamic plugin packages like the others; another category would add a third package kind to documentation and gates.

**Keep root value imports and alias the package root to `/client` in Vitest and the benchmarks.** About five hundred files would keep a form that works only where an alias exists, and every new test lane or tool would need the alias.

**A hand-written `src/index.d.ts` that re-exports `./client/index.ts`.** The root would be a separate declaration file: mixed augmentations would merge in one processing order only, an augmenting program would fail with TS2664 unless it also loads the root, and gates that resolve configured rows would need to accept a declaration file under `src/`.

**Augment the package root in the repository and reject `/client` augmentations.** It needs the forwarding declaration file above and fixes the repository on the specifier that is not recommended.

**Convert `client-store` as well.** `client-store` is a leaf library that imports no DSH package; it stays statically linked, and a store service, if one is needed, becomes a new package with its own lifecycle rather than a conversion of this one.

## Consequences

- The Web shell no longer bundles the three packages, KaTeX, Shiki, or the Markdown parser, and still bundles `client-store`, Zustand, and Immer; a composition that replaces the Web client must list the three rows ([upgrade guide](../../../../docs/upgrade-guide/v0.2.3-alpha.2/client-packages-dynamic-plugins/guide.md)).
- Repository code and external code share one recommended specifier, and code written against the package root keeps compiling and loading.
- In Node the package root yields only the Host entry, so tests and tools that run these packages' browser code import `/client`.
- Gates that resolve configured row names, such as [`verify-cordis-config`](../../../../scripts/verify-cordis-config.ts), reach the Host entry `src/index.js` under `src/`.
- The TypeScript commitment holds because the published root and `./client` share one declaration file; the consumer check's negative control shows that a separate root types file that forwards to `./client` would split mixed augmentations.
- New shared runtime code goes through Cordis services, slots, or browser-safe utility packages, never into the value exports of these three packages.
