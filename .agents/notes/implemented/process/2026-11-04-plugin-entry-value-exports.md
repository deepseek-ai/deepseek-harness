# Agent Note: Plugin entries must not add value exports

Status: implemented

English | [中文](2026-11-04-plugin-entry-value-exports.zh.md)

## Problem

[The package surface rules](../../../../docs/defensive-patterns/package-surface.md) limit a plugin entry to what the Cordis Loader loads: a function plugin's entry exports `name`, `inject`, `Config`, and `apply`, a service plugin's entry default-exports its plugin class, and beyond those a Host entry may export only the Service Definition classes and error types that other packages extend or throw. No gate checked the rule, and value exports beyond it accumulated on many plugin entries; `dsh-mcp-client`'s entry, for example, gained `probeServer`, `ReconnectSchema`, and four other values that `dsh-mcp-manager` imports.

The Cordis Loader imports a plugin entry when its row activates and reads only what the plugin form provides: the Loader fields from a function plugin's module namespace, or a service plugin's default-exported class. Any other value on the entry is API that another package can import statically, and that import evaluates the entry module and its dependencies when the importer loads, without the row's activation or `inject` wait.

## Decision

The gate [verify-plugin-entry-exports](../../../../scripts/verify-plugin-entry-exports.ts) enforces the rule for both plugin forms:

- **Scope**: every `packages/<group>/<package>/src/index.ts` that is a plugin entry. An entry that exports a value named `apply` is a function plugin. An entry without `apply` whose default export is a class the Loader can construct is a service plugin. Libraries, a default export that is not a class, and an abstract default class are not checked; an abstract class defines a capability seam that providers extend, and the Loader cannot construct it.
- **Compiler faces**: the gate reads each entry through the Host compiler face and then the Client face, and the first face that compiles an entry classifies it. An entry that neither face compiles fails the gate, and so does a corpus without a function plugin entry or without a service plugin entry.
- **Rule**: a function plugin entry may export `name`, `inject`, `Config`, and `apply`, and a service plugin entry may export its default class under any name. Either may also export types and values whose every construct signature builds an instance whose base types reach Cordis `Service` or the global `Error`. Class declarations, class expressions, and mixin results pass on the same terms. Every other value fails, including a value that arrives through `export *`, an export whose target does not resolve, and an `export *` whose module does not resolve, which is reported as `*`. A service plugin entry's `name`, `inject`, and `Config` fail like other values, because the Loader reads them from the class. A default export beside `apply` fails whatever it holds, even an allowed class, because the Loader then loads the default export instead of the module namespace.
- **Value or type**: decided by the names the entry exports at run time, with module targets and local bindings resolved against the bound Program because `verbatimModuleSyntax` is off, as in [verify-optional-dependency-imports](../../../../scripts/verify-optional-dependency-imports.ts). Type-only exports and declarations emit nothing, a re-export emits only a run-time export of its target, and `export *` brings in every run-time name of its target except `default` and the names the module exports itself. An `export type` therefore does not hide a value that `export *` provides under the same name, and a name that only `export type *` reaches, at any depth, is a type.
- **Existing exports**: [plugin-entry-existing-exports.ts](../../../../scripts/plugin-entry-existing-exports.ts) lists, by package, the value exports that entries had when the gate arrived. A line records debt, not an approved exception. A listed export passes. A line fails when its package has no entry or its entry is not a plugin entry, when its export list is empty or repeats a name, and when it names an export the entry no longer reports, so removing an export removes its line in the same change. No document or test records the number of listed exports; the gate prints the number it matched.
- **Registration**: a shared hygiene gate in [run-gates](../../../../scripts/run-gates.ts), so it runs in the CI static lane, in master CI, in the local `hygiene` and `check-all` aggregates, and in the Windows observational lane.

## Alternatives considered

**Compare the list with the pull request base in CI.** CI already passes the base commit to the [frozen-archive gate](2026-07-26-frozen-agent-note-archive.md), so a gate could reject every line a change adds. The comparison also rejects legitimate changes: renaming a package moves its lines to a new key, and reverting an export removal restores a line. Additions stay a review decision, as they are for the other allowance lists in this repository.

**Generate a baseline and prune it with a command.** The [unknown-cast gate](2026-09-19-no-unknown-casts.md) keeps a generated JSON baseline with a `--prune` command. A hand-edited TypeScript list keeps one readable entry per package in the diff, and the gate's validation names the line to delete.

**Check only function plugin entries.** The rule's judged condition names a function plugin's `src/index.ts`, but its first paragraph describes both entry forms and allows a Host entry only the Service Definition classes and error types beyond what the Loader loads. A value that another package imports from a service plugin entry bypasses the row in the same way, and a gate limited to function plugins would let an entry escape it by default-exporting a class.

**Check Loader rows that name a package subpath.** A Loader row can name a module other than the package root. Finding those modules requires reading every profile, bundle, and preset composition, which this gate does not do, so review still owns them.

**Remove every existing export in the same change.** Removing the listed exports needs test and consumer changes in dozens of packages. The list lets the gate block new exports immediately while each package removes its own.

**Judge classes by declaration syntax.** Allowing only `class` declarations that extend `Service` or `Error` rejects class expressions and mixin results that construct the same instances. The gate judges what an export constructs.

## Consequences

A new value export on a plugin entry fails CI with the file, line, package, and export name, and the message names the rule and the way out. Existing exports keep working until their packages remove them, and each removal shortens the list.

The gate builds the Host Program and then the Client Program, and releases the first before building the second, so its peak memory stays near that of the Host Program, like verify-optional-dependency-imports.

Loader rows that name a subpath, default exports that are not classes, deep imports through `./src/*`, and consumers that import a listed export stay outside the gate, and review still owns them. `/client` entries follow [the Client package rules](../../../../packages/client/AGENTS.md), and the Client build already rejects cross-plugin value imports. The list accepts an added line like any other file, so an addition depends on review.

## Testing

[verify-plugin-entry-exports.spec.ts](../../../../scripts/verify-plugin-entry-exports.spec.ts) compiles a fixture with its own Host and Client configs and a stand-in Cordis `Service`. It pins each reported and passing export form, including the run-time paths through `export type` and nested `export type *` and base classes that only share a root's name, the three ways an entry exports `apply`, an `apply` that only a type-only path reaches, service plugin entries whose default class extends `Service` or no class, the entries that are not plugins (a library, an abstract default class, and a default-exported function), an entry only the Client face compiles, an entry neither face compiles, every list validation, a corpus without either plugin form, and a manifest without a name. [run-gates.spec.ts](../../../../scripts/run-gates.spec.ts) pins the gate's registration. Adding a value export to a real function plugin or service plugin entry and removing a listed export makes the gate report both.
