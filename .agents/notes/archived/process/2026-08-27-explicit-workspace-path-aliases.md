# Agent Note: Explicit workspace path aliases replace per-group wildcards

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-27-explicit-workspace-path-aliases.zh.md)

## Problem

`tsconfig.base.json` is the resolution facade for the whole repository: every package project extends it, both aggregates read it, and every Vitest config points `vite-tsconfig-paths` at it. Two of its aliases carried one candidate per package *group* rather than one per package — `@deepseek-ai/dsh-*` listed 49 candidate globs and `@deepseek-ai/dsh-*/invariant` listed 45.

TypeScript and tsx try those candidates in order and take the first that exists, so a specifier whose package sits late in the list pays for every earlier miss. Under the `dsh` source launch each miss is an `ERR_MODULE_NOT_FOUND` that Node decorates with `decorateErrorWithCommonJSHints`, which runs a full CommonJS resolution walk per failure. A profile of a source-launch boot attributed 934.6 ms — 35% of the boot — to that decoration path alone, from 60,942 failed resolutions.

The cost fell hardest on the most-imported packages. `packages/util/*` sat at position 44 of 49 and holds the leaf utilities nearly every plugin imports, so `dsh-timeout` paid roughly 9 ms per resolution against 0.05 ms for a specifier with an explicit alias.

## Decision

`scripts/gen-tsconfig-paths.ts` writes one explicit alias per workspace package into a marked region at the end of `paths`, and both group wildcards are deleted. `pnpm run gen-tsconfig-paths` rewrites the region; `pnpm run verify-tsconfig-paths` reports drift instead, and runs in the `ci-static` lane beside the other generated-artifact checks.

The generator emits an alias only for a package whose declared name is exactly `@deepseek-ai/dsh-<directory>`, because that is the only shape a wildcard could ever have resolved: it substituted the specifier's suffix into `packages/<group>/<suffix>/src`. Packages named after something other than their directory — `@deepseek-ai/dsh-typert-protocol` at `packages/typert/protocol`, the `dsh-client-*` and `dsh-host-*` families — already carry hand-written aliases and are left alone. A specifier claimed by two package directories throws rather than picking one, because an explicit map cannot express the group-order tiebreak the wildcard used; no such collision exists today.

Deleting the wildcards removed the fallback that used to resolve a package nobody had aliased, so the generator also asserts coverage: every workspace package carrying a `src` directory must be mapped by a generated or hand-written alias, and `--check` names any that is not. Without it a package whose name does not match its directory could be added, skipped by the generator, and left resolving through the workspace symlink to built `lib/` output — the same artifact-plane leak the explicit aliases exist to close.

The region is written by text surgery between marker comments rather than by re-serializing the file. `tsconfig.base.json` is JSONC and its hand-written aliases carry comments that explain non-obvious mappings; re-serializing would drop them.

This partly supersedes the [package-inventory discovery proposal](../../proposed/process/2026-06-20-discover-package-inventory.md), which records the collapse into one wildcard as current: the wildcard is gone, while that proposal's remaining subject — the aggregate configs' explicit `references` arrays — is untouched here.

Four wildcards remain, each with a single candidate: `dsh-host-*/invariant`, `dsh-client-*/invariant`, `dsh-client-*/client`, and the five `dsh-host-<name>/*` subpath maps. One candidate costs one probe, so expanding them would trade file size for nothing.

## Resolution differences this change makes

Every `@deepseek-ai/dsh-*` specifier appearing in repository sources — 1,023 distinct — resolves to the same target as before, with eleven exceptions that now resolve where they previously did not. All eleven previously reached built `lib/` output through the workspace symlink rather than source.

Seven are `/invariant` subpaths: `dsh-invariants/invariant`, `dsh-lsp/invariant`, `dsh-lsp-stdio/invariant`, `dsh-tool-lsp/invariant`, `dsh-terminal/invariant`, `dsh-terminal-bash/invariant`, and `dsh-tool-terminal/invariant`.

The deleted `dsh-*/invariant` wildcard omitted the `lsp`, `terminal`, `client`, and `host` groups. The `client` and `host` omissions are deliberate and documented — those families have dedicated wildcards because their package names prefix the group directory. The `lsp` and `terminal` omissions have no such reason, and `packages/runtime-diagnostics/invariants` appeared in neither list. Those seven specifiers therefore resolved through the workspace symlink and the package's `./invariant` export to built `lib/types/*.d.ts` instead of to source, which contradicts the rule that static gates resolve workspace imports through `paths` to `src` and pass on a clean tree. Making the aliases uniform resolves them to source like every sibling.

The other four are whole packages the coverage assertion surfaced: `dsh-client-ui-directory-picker-browse`, `dsh-client-ui-directory-picker-native`, `dsh-experimental-agent-team-profile`, and `dsh-experimental-agent-team-web-profile`. Each is named `dsh-<group>-<directory>`, which no wildcard could ever substitute, and each sits beside siblings that do carry hand-written aliases — they were simply missing. They now carry one too.

## Testing

`scripts/gen-tsconfig-paths.spec.ts` pins that the collector maps a package to its own directory, skips packages carrying hand-written aliases, and returns a sorted list; that the renderer yields to a hand-written specifier and closes the region without a trailing comma; that the region writer replaces only the marked span and refuses a config without markers; and that neither group wildcard survives in the committed config. Two further cases pin the coverage assertion: it names an unmapped package, and it reports none against the committed config.

The gate's rejection path is exercised directly: deleting one generated alias makes `verify-tsconfig-paths` exit non-zero, and restoring it makes the check pass.

The CLI entry guard uses the repository's established comparison, `import.meta.filename === resolve(process.argv[1])`, rather than concatenating a `file://` URL. The concatenated form fails whenever `import.meta.url` percent-encodes something `process.argv[1]` does not — a repository path containing a space, or any Windows drive path — and the failure is silent: the script exits 0 having done nothing, which would make the gate a no-op exactly where it is needed. Running a copy from a directory whose name contains a space reproduces that: the concatenated guard evaluates false, the established one true.

## Alternatives considered

**Reordering the wildcard's candidate globs so the hottest groups come first.** This needs no generator and no new gate, and recovers perhaps half the cost by moving `util`, `core`, `llm`, and `session` to the front. It was rejected because the win decays as packages are added, the ordering has no invariant a reader could check, and every group after the first still pays. It also leaves the worst property intact: adding a package group silently slows every boot.

**Moving `paths` into a generated `tsconfig.paths.json` that the base config extends.** This keeps the generated content out of the hand-written file entirely and produces a cleaner diff. It was rejected for this change because several consumers read `tsconfig.base.json` directly rather than through a resolver that follows `extends` — six Vitest configs plus `project-reference-faces.ts`, `verify-export-jsdoc.ts`, `doc-typecheck.ts`, and `rescope-vendor.ts` — and auditing each is a larger change than the aliasing itself. The marker region achieves the same isolation with no consumer risk.

**Keeping the wildcards as a fallback beneath the explicit aliases.** An explicit alias already wins over a wildcard, so correctness would be unchanged, and a package added without regenerating would keep resolving. It was rejected because the fallback is exactly what makes a stale config invisible: the repository's stance is that misconfiguration fails loud, and the `--check` gate turns a missing alias into a named failure instead of a slow boot nobody attributes.

## Consequences

A source-launch boot of the `headless` profile drops from a 2,157/2,182/2,153 ms baseline to 1,069/1,052/1,055 ms — about 1.1 seconds, or 51%, with the two ranges nowhere near overlapping and `--help` output byte-identical.

The win is confined to the tsx source launch. Vitest resolves through `vite-tsconfig-paths`, which matches in-process and checks file existence without ever constructing a Node module error, so it never paid the decoration cost: an A/B over one package's suite measured 5,934/5,829/5,908 ms against 5,878/5,851/5,905 ms, which is noise. Repository gate scripts import few `@deepseek-ai/dsh-*` packages and likewise show no separable difference. Shipped users run built `lib/` under plain Node and were never affected.

`paths` grows from 188 keys to 523, and adding a package now requires running the generator. The `--check` gate makes that a named failure rather than a silent one, and the generated region keeps the diff of such a change to a single line.
