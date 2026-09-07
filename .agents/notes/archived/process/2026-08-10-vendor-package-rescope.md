# Agent Note: Rescope vendored Cordis into @deepseek-ai

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-vendor-package-rescope.zh.md)

## Problem

The nine packages under `vendor/` kept their upstream npm names (`cordis`, `cosmokit`, `schemastery`, `@cordisjs/plugin-*`). That premise does not survive publication: every harness package declares `cordis` as a peer dependency, so a consumer installing `@deepseek-ai/dsh-*` must resolve it from the registry, which means publishing the harness publishes this framework layer too. Publishing it under the upstream names squats them on the registry, and where that registry proxies npmjs, the same-name entries shadow the real upstream packages and install the wrong framework into unrelated projects.

## Decision

All nine packages move into the `@deepseek-ai` scope. Directory names, upstream version numbers, and dependency ranges stay untouched, so the `vendor/README.md` manifest still reads as an upstream snapshot. [docs/rescope.md](../../../../docs/rescope.md) restates this mapping for consumers.

| Directory | npm name | Upstream name |
|---|---|---|
| `cordis/` | `@deepseek-ai/cordis` | `cordis` |
| `cosmokit/` | `@deepseek-ai/cosmokit` | `cosmokit` |
| `schemastery/` | `@deepseek-ai/schemastery` | `schemastery` |
| `loader/` | `@deepseek-ai/cordis-plugin-loader` | `@cordisjs/plugin-loader` |
| `include/` | `@deepseek-ai/cordis-plugin-include` | `@cordisjs/plugin-include` |
| `group/` | `@deepseek-ai/cordis-plugin-group` | `@cordisjs/plugin-group` |
| `timer/` | `@deepseek-ai/cordis-plugin-timer` | `@cordisjs/plugin-timer` |
| `hmr/` | `@deepseek-ai/cordis-plugin-hmr` | `@cordisjs/plugin-hmr` |
| `logger-console/` | `@deepseek-ai/cordis-plugin-logger-console` | `@cordisjs/plugin-logger-console` |

The rewrite touches only **delimited, complete package-name tokens**: quoted or backticked specifiers (optionally with a `/subpath`), `package.json` names and dependency keys, `cordis.yml` `name:` values, and `tsconfig.base.json` `paths` keys. Identically spelled strings that are not package names therefore stayed as they were: the `cordis.yml` config-file family, the Loader's literal `cordis:` builtin prefix (`cordis:include`, `cordis:group` — see `vendor/loader/src/config/tree.ts`), kind strings like `cordis-config-entry`, `@deepseek-ai/dsh-tool-cordis`, Schemastery's upstream `Symbol.for('schemastery')` and `vendor:` metadata field, the `packages/<group>/` directory names in `GROUP_ORDER` (`scripts/gen-module-graph.ts`, `scripts/gen-doc-graphs.ts`), and the upstream install instructions in `vendor/*/README.md`.

Two classes are invisible to a token rule and were renamed site by site. First, property access — `manifest.peerDependencies?.cordis` — where TypeScript cannot catch a stale `Record<string, string>` key. Second, constants that carry the name as data: the vendored set in `check-workspace-constraints.ts`, the group/include names in `verify-cordis-config.ts`, the `declare module` target strings in `cordis-walk.ts`, `gen-scoped-events.ts`, and typert's `analyzer.ts`, and `alwaysBundle` in `app-boot/tsdown.config.ts`.

Markdown splits along what a reader does with it. Every fence follows the rename regardless of its info string, because a fence is code they copy or configuration they mount — the `yaml` fences naming Loader plugins and the `ts ignore-check` fences beside compiled ones included. Prose follows it under `docs/`, where a tutorial sentence quoting a name teaches something this repository no longer resolves. Prose elsewhere — `vendor/*/README.md`, package READMEs, and `.agents/notes/` — keeps the names it was written with, both because it records what was true then and because the same spelling can mean something else: the Python SDK's `cordis` option, the unvendored `@cordisjs/plugin-http`, or an agent-preset id.

## Consequences

- No upstream name remains in the publication set. `publish-npm-baseline.ts` now requires every published package to be `@deepseek-ai/*` with no vendored exemption, so regressing the rename fails before packing.
- The `vendor/README.md` manifest table gains an upstream-name column; `gen-third-party-notices` parses six columns and renders that name into `THIRD_PARTY_NOTICES.md`, keeping MIT attribution pointed at each fork's origin rather than our scope.
- `pnpm-workspace.yaml` drops the `cordis` and `@cordisjs/plugin-loader` `minimumReleaseAgeExclude` entries, which can no longer be fetched from a registry.
- Upstream sync follows the procedure in `vendor/README.md` with one added obligation in step 3: re-apply the rename over the copied sources with `pnpm run rescope-vendor --apply`, whose mapping and the table's two name columns must agree.
- **Returning to the official upstream packages** means applying that mapping in reverse — `pnpm run rescope-vendor --apply --reverse` — then restoring the two `minimumReleaseAgeExclude` entries and relaxing the publication-set assertion. It spans roughly 1300 files, so replay it with the script rather than by hand.

`scripts/rescope-vendor.ts` owns the rename: the mapping, the delimited-token rule, the per-file exemptions where a name is a directory instead of a package, the exact edits above, and a `--check` mode asserting no residue, every exact edit landed, and idempotency, which the `hygiene` gate runs on every CI pass. A rebase replays it instead of resolving a 1300-file conflict, and an upstream change to one of the pinned sites fails the run loudly instead of being silently skipped.

## Alternatives considered

**Keep the upstream names and exclude `vendor/` from publication.** Rejected because every harness package declares `cordis` as a peer dependency, so an installed `@deepseek-ai/dsh-*` would have no resolvable framework.

**Rename only at pack time.** Rejected because the published names would disagree with the source tree, every module specifier would have to be rewritten inside the publish path, and no local run could reproduce what was published.

**Rename the `vendor/` directories and unify versions on the repository base version too.** Rejected because directory names are not publication identity — renaming them drags in project references, tsdown globs, and documentation paths for no gain — and a `0.0.1` version would no longer satisfy the preserved `^4.0.0-rc.7` ranges, so pnpm would look for a registry copy and `verify-vendored-links` would fail.

**Rewrite prose outside `docs/` and historical Agent Notes as well.** Rejected because those record what was true when written, and a bare `cordis` there is as likely to be an SDK option name or a preset id as a package; `docs/rescope.md` carries the mapping for readers instead.
