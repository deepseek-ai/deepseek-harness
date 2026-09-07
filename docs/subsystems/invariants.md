# Runtime Invariants

English | [中文](invariants.zh.md)

[dsh-invariants](../../packages/runtime-diagnostics/invariants) is the configurable registry service (`ctx.invariants`) for package-owned runtime invariant checks. It is one support-group package, not a three-package capability seam, and not part of the agent-loop spine: the registry owns selection, name reservation, child-fiber lifecycle, and package-attributed failure, while every workspace package publishes a `./invariant` companion plugin that registers checks under its exact npm package name. What a check may assert — authoritative event streams or mutable data, never service or method presence — is the runtime-invariants convention in [AGENTS.md](../../AGENTS.md#conventions).

Source: [`packages/runtime-diagnostics/invariants/src/index.ts`](../../packages/runtime-diagnostics/invariants/src/index.ts)

## Selection

```ts type-equiv
/** Runtime invariant selection configured on the service plugin. */
interface Config {
  /** Global switch; defaults to `true`. */
  readonly enabled?: boolean
  /** Case-sensitive JavaScript regex sources that admit package names; empty admits all. */
  readonly package_allowlist?: string[]
  /** Case-sensitive JavaScript regex sources that exclude package names after allowlist matching. */
  readonly package_blocklist?: string[]
}
```

A package is selected when the service is enabled, the allowlist is empty or at least one pattern matches its full npm name, and no blocklist pattern matches — a blocklist match overrides an allowlist match. Entries compile with `new RegExp(source)`: matching is unanchored unless the source supplies `^` and `$`, and `/pattern/flags` syntax is not parsed. Validation fails loud at service startup: a blank, whitespace-padded, duplicate, or invalid entry throws instead of being skipped. A valid pattern may match no currently loaded package, so later loading and HMR stay deterministic; filters are fixed for the service lifetime ([README](../../packages/runtime-diagnostics/invariants/README.md)).

## The installer

```ts type-equiv
/**
 * Throw a package-attributed invariant failure.
 * @param message - violated package contract without the standard prefix.
 * @returns never because reporting a violation throws.
 */
type InvariantFailure = (message: string) => never
```

```ts type-equiv
/** Install one package's checks into the registration's child context. */
interface InvariantInstaller {
  /**
   * Install the package contribution.
   * @param ctx - child context owned by this invariant registration.
   * @param fail - reporter bound to the registering package name.
   * @returns nothing, or a promise settling after asynchronous checks finish.
   */
  (ctx: Context, fail: InvariantFailure): void | Promise<void>
  /** Services the child installer fiber may access. */
  readonly inject?: Inject
}
```

An enabled installer runs in a dedicated child Cordis fiber; `installer.inject` declares the services that fiber may access, and synchronous or asynchronous installer completion is joined before the registration succeeds. `fail(message)` throws `InvariantError` — `extends Error` with stable `code: 'INVARIANT'`, the owning `packageName`, and a message prefixed `invariant violated by "<package>": …` — so a violation is attributable without the registry importing any product package.

## The service

`ctx.invariants.register(packageName, installer)` reserves one active registration for the full npm package name and returns its effect-scoped disposer. The reservation holds even when filters keep the installer inactive, so two plugins can never silently claim the same package name; a duplicate, blank, or whitespace-containing name throws. An installer failure disposes the child fiber and releases the reservation atomically. The service owns every registration fiber while the returned disposer also belongs to the companion fiber: unloading either side removes listeners, trace state, and the reservation, so a companion can reload and register the same name again without retained state.

## The companion contract

Every workspace package owns a `./invariant` companion ([package contract](../../packages/AGENTS.md)); publication and registration are exhaustive, but assertions are deliberately not synthetic. A companion installs a check only when its package owns an observable event or mutable-data relationship; otherwise it exports an empty installer whose leading comment starts `No runtime invariant:` and explains, package-specifically, why nothing is checkable. `pnpm run verify-package-invariants` mechanically rejects generated markers, unexplained empty installers, non-empty installers that omit or ignore the reporter, incorrect registration names, and incomplete export, publication, dependency, or bundle wiring ([mechanical-rule Agent Note](../../.agents/notes/implemented/architecture/2026-07-19-package-invariant-runtime-contracts.md)). The catalog of executable companions and the standard composition live in the [package README](../../packages/runtime-diagnostics/invariants/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxinvariants--invariantregistry"></a>

### `ctx.invariants` — `InvariantRegistry`

Package-owned invariant registry with global and regex-based selection.

```ts cordis-catalog
/**
 * Register one package's invariant installer. The package name is reserved
 * even when filtering disables its checks. Enabled installers run in a child
 * fiber; failure disposes that fiber and releases the reservation.
 * @param packageName - full npm package name that owns the contribution.
 * @param installer - listener or startup-check installer for the child context.
 * @returns an effect-scoped disposer for the registration.
 */
register(packageName: string, installer: InvariantInstaller): () => void
```

Source: [`packages/runtime-diagnostics/invariants/src/index.ts`](../../packages/runtime-diagnostics/invariants/src/index.ts)
<!-- END GENERATED cordis-surface -->
