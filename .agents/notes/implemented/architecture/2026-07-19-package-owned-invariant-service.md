# Agent Note: Package-owned invariant service contract

Status: implemented

English | [中文](2026-07-19-package-owned-invariant-service.zh.md)

## Problem

Runtime invariant checks span session traces, agent state, scoped dispatch, and request reconstruction. Putting all checks in one diagnostics package makes that package import product vocabularies from unrelated domains, centralizes tests away from their owners, and requires the central package to change whenever a product package adds or removes a check.

Deployments that opt into diagnostics need more than presence or absence of one plugin. Such a composition carries the known invariant contributions while permitting a global off switch and package-selective diagnostics. Selection must remain stable when a package loads later or reloads under HMR, and disabled contributions must not allow two plugins to claim the same package name silently.

Published ownership must be mechanically complete. Without a repository rule, a package can expose a partial companion, dependency, or publication map and remain broken until a maintainer notices the gap; packages that publish none must keep their reason reviewable in the README.

## Decision

### One registry service, package-owned contributions

`@deepseek-ai/dsh-invariants` is a product-independent Cordis service plugin that registers `ctx.invariants`. It owns configuration, registration uniqueness, child-fiber lifecycle, and package-attributed failures. It imports no session, agent, scope, or agent-loop package and contains none of their checks.

A workspace package publishes a `./invariant` companion plugin only when it owns an independently observable event or mutable-data relationship. The companion registers its exact full npm name. Packages without such a relationship omit the companion and publication wiring and record the reason in their README; generated placeholders, empty installers, and synthetic API-shape assertions are forbidden by the [runtime-contract Agent Note](2026-07-19-package-invariant-runtime-contracts.md) and [omission decision](../simplification/2026-08-28-omit-unneeded-invariant-companions.md). Package root entrypoints do not import or register diagnostics implicitly, so loading a root package does not change runtime checking or require the invariant service.

### Configuration and selection

```ts
interface Config {
  enabled?: boolean
  package_allowlist?: string[]
  package_blocklist?: string[]
}
```

Defaults are `enabled: true`, `package_allowlist: []`, and `package_blocklist: []`. For a full registration name, selection is:

```ts
export function selected(enabled: boolean, package_allowlist: RegExp[], package_blocklist: RegExp[], packageName: string): boolean {
  return enabled
    && (
      package_allowlist.length === 0
      || package_allowlist.some(pattern => pattern.test(packageName))
    )
    && !package_blocklist.some(pattern => pattern.test(packageName))
}
```

Blocklist matches override allowlist matches. Each list entry is a case-sensitive JavaScript regex source compiled by `new RegExp(pattern)`. Matching is unanchored unless callers supply `^` and `$`; slash-delimited syntax and flags are not interpreted. Startup rejects blank, whitespace-padded, invalid, or duplicate sources within either list. A source that matches no loaded package remains valid because registration order, later loading, and HMR must not change config validity.

### Registration and failure ownership

The public registration boundary is `ctx.invariants.register(packageName, installer)`. It reserves one active registration per full npm package name even when filters disable installation, and returns the effect disposer. Disposing the companion or service releases the reservation and all contribution state.

An enabled installer runs in a dedicated child Cordis fiber owned by the service. `InvariantInstaller.inject` declares the child fiber's service API explicitly; the registry carries no product-specific dependency metadata. The service joins a returned installer promise before registration succeeds, so asynchronous startup checks remain transactional. The installer receives a bound `fail(message)` reporter. Calling it throws an `Error` subclass named `InvariantError` with stable code `INVARIANT` and the registering `packageName`; it does not extend a product-package error base.

Registration setup is transactional. If an installer fails after registering listeners, the child fiber is disposed completely and the name reservation is released before the failure escapes. Filtered registrations create no child but retain their reservation until disposal. Reloading a companion therefore begins with one clean installer state; stateful contributions rebuild baselines from their owning services.

The former functional-plugin entry point and one-argument `InvariantError` constructor are not retained as compatibility APIs. The repository is pre-release and all call sites move to the service and package-attributed error together.

### Initial stateful companions and exhaustive ownership

| Companion entry | Registration name | Owned checks |
|---|---|---|
| `@deepseek-ai/dsh-session/invariant` | `@deepseek-ai/dsh-session` | session sequence, turn/step enclosure, and same-step call/result trace |
| `@deepseek-ai/dsh-agent/invariant` | `@deepseek-ai/dsh-agent` | agent-status transitions |
| `@deepseek-ai/dsh-scope/invariant` | `@deepseek-ai/dsh-scope` | scoped-event carrier presence and subject consistency |
| `@deepseek-ai/dsh-agent-loop/invariant` | `@deepseek-ai/dsh-agent-loop` | model-request reconstruction |

These four owners supplied the initial stateful checks. Later owners add companions for real event or mutable-data relationships, while packages without one omit the companion and document why. Every published companion is a separately bundled `./invariant` export with its own declarations and Loader-safe namespace plugin shape.

`verify-package-invariants` discovers every workspace package, accepts clean omission, and rejects partial companion wiring, generated markers, empty installers, installers that omit or ignore the reporter, foreign or unresolved registration names, missing `./invariant` exports or published files, missing invariant peer/development dependencies and project references, and bundle overrides that omit a published companion entry.

### Scoped-event semantic map

The generated scoped-event subject resolver lives in `dsh-scope`, beside the contract and invariant that consume it. `gen-scoped-events` uses the root TypeScript Program to enumerate `this: Scoped<Base>` declarations, infer routing-key types from real `scopeTarget(base, key)` calls, and require one unambiguous payload subject or an explicit unsupported marker. The committed runtime map imports no event-owner package, so semantic completeness does not expand either the service or scope package's runtime closure.

### Example composition and SDK output

The `dsh-sdk-minimal` patch mounts the service and all four stateful companion subpaths as explicit rows. A subpath entry adds its installable root npm package rather than treating the subpath as a package name. The shipped base-backed config trees omit the service and companions under the [shipped-config decision](../simplification/2026-08-03-omit-invariants-from-shipped-config.md).

Workspace constraints recognize the separate invariant bundle, and package exports, project references, build configuration, dependency declarations, and the lockfile describe the same publication metadata. Generated config catalogs, module graphs, and API documentation derive from those sources.

## Testing

Service tests cover defaults, global disablement, allow/block selection, blocklist precedence, anchoring, unanchored matching, case sensitivity, invalid configuration, zero-match patterns, late registration, duplicate ownership, disposal, rollback, and HMR re-registration. Owners with executable checks keep positive and negative behavior beside the companion source.

Composition tests cover standard-spine forwarding and generated SDK entries. Loader tests preserve each companion namespace, while built plain-Node smokes exercise the compiled subpath exports. The scoped-event freshness gate reruns its semantic Program analysis.

Every Vitest configuration loads a test host that mounts an explicitly enabled service before an ordinary Cordis root's first plugin and adds the current test package's companion when one exists. One exhaustive topology mounts all published companions once; focused service and owner tests construct their own invariant topology so they can exercise disablement, filtering, rollback, and reload without duplicate ownership. Gate tests also execute every published companion's `apply` function and verify that it calls `register` with its manifest name, rather than accepting source text alone.

## Alternatives considered

- **Keep all checks in `dsh-invariants`.** Rejected because the registry would continue importing every checked product domain, owner changes would require central edits, and package tests would remain detached from the contracts they protect.
- **Let root package entrypoints register checks implicitly when `ctx.invariants` happens to exist.** Rejected because root behavior would depend on composition order and optional service presence, diagnostics could not be selected independently, and package loading would hide a registration effect outside an explicit companion.
- **Discover every `invariant.ts` file automatically at runtime.** Rejected because filesystem/package discovery is not a runtime ownership contract, makes bundled publication ambiguous, and cannot express explicit Cordis load order or dependency installation. Build-time generation, verification, and the test host may enumerate the source tree because they validate repository completeness rather than composing a shipped deployment.
- **Validate allow/block entries against the currently loaded package set.** Rejected because a zero-match pattern can intentionally target a later or HMR-loaded contribution; current load order must not determine config validity.

## Consequences

- Product packages own and test their relational assertions while the service stays product-independent.
- Only owners with a meaningful runtime relationship pay the publication, dependency, listener, or trace-state cost of a companion; other packages record the omission reason in their README.
- Compositions that mount the diagnostics can disable all checks or select package names without changing their plugin tree.
- Explicit companion entries make diagnostic cost and ownership visible in Cordis config and package exports.
- One selected contribution adds one child fiber and its listener/state cost, while filtered registrations retain only name ownership.
- Regex sources are deployment configuration and remain fixed until the service reloads.
- Ordinary Vitest roots install the owning test package's selected companion when published; one exhaustive topology pays the full child-fiber cost once for repository-wide registration coverage.
- Session storage validation, snapshotting, freezing, cited source-event validation, and surface acceptance remain always on and are not affected by invariant selection.
