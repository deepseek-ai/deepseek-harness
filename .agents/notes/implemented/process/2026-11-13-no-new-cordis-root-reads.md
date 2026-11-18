# Agent Note: Prohibit new reads of the Cordis root context

Status: implemented

English | [中文](2026-11-13-no-new-cordis-root-reads.zh.md)

## Problem

`ctx[Context.root]` returns the application's root context. A property read through it skips the `inject` check, because the root fiber has no runtime; a listener registered on it skips scope filtering; and it reads the root realm instead of the caller's isolate realm. DSH code uses it to read undeclared services, to listen to every Agent's events, to key per-application state, and to call boot APIs that require the root context. Each of these uses has, or needs, a declared replacement: an `inject` entry, `{ global: true }` on a listener, or a service that owns the root-level operation.

The repository contains such reads across boot, host, preset, protocol, experimental, and test owners. Replacing all of them in one change would combine the enforcement decision with several service designs.

## Decision

New reads of the Cordis root context are prohibited in first-party JavaScript and TypeScript, including tests, fixtures, and scripts. The [checker](../../../../scripts/verify-cordis-root.ts), exposed as `pnpm run verify-cordis-root`, uses the TypeScript syntax tree and a type checker over each file alone. A read names the root symbol through a Cordis value binding of `Context` or `symbols`: `.root`, `['root']`, or `root` destructured in a declaration, a parameter default, or an assignment. A binding comes from `@deepseek-ai/cordis` or one of its subpaths through a static import, including renamed, default, namespace, and `import =` forms, or through a destructured or namespace `import()` or `require()` result; a local that shadows the import is not a binding. Any string literal whose value is exactly `cordis.root`, the key behind `Symbol.for('cordis.root')`, is also a read. Type positions, interfaces, type aliases, ambient declarations, comments, other strings, and source text embedded in a template are not reads.

Existing reads have an exact baseline in `scripts/cordis-root.baseline.json`, kept by [the shared inventory module](../../../../scripts/baseline-inventory.ts) under the rules of the [unknown-cast inventory](2026-09-19-no-unknown-casts.md): baseline edits only delete entries or decrease counts, `--prune` removes retired entries and refuses to write while new reads exist, and no command adds an allowance. A read's fingerprint covers the tokens of the element access whose key is the root symbol, so a recorded read moved to another receiver is a new finding.

Files that exercise the root contract itself are listed with a reason in `CORDIS_ROOT_EXEMPTIONS` inside the checker and are not scanned: the Cordis rc.12 specification and the checker. An exemption whose file no longer reads the root fails the gate. Vendored sources and frozen archived Agent Notes keep their inventory exclusions. The checker runs in CI static and primary modes and the local `hygiene` and `check-all` profiles in [the gate runner](../../../../scripts/run-gates.ts). The [defensive pattern](../../../../docs/defensive-patterns/general.md#plugins-do-not-read-the-cordis-root-context) states the rule and its replacements for authors, and the gate's rejection message links it.

## Alternatives considered

**Replace every existing read before enforcing the rule.** Rejected because several replacements need new services, such as a profile-composition service for the boot APIs and an application-lifecycle signal; enforcing first stops new reads while those designs are reviewed separately.

**Use the `no-restricted-properties` lint rule.** Rejected because it matches the identifier `Context` by name, so a renamed import such as `CordisContext` passes, and it cannot match `Symbol.for('cordis.root')`.

**Record the exempt files in the baseline.** Rejected because the baseline only shrinks, while the exempt files are expected to keep their reads; keeping them apart lets the baseline reach empty.

## Consequences

Owners must remove a recorded read before changing its receiver or moving it into an unlisted file, and prune its entry after removal. Passing the check establishes that no unlisted syntactic root read exists. It does not detect a root context obtained through another value, such as a stored reference, an alias of `Context`, a service that returns it, or code assembled from strings at runtime.
