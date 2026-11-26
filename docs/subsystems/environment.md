# Execution environments

English | [中文](environment.zh.md)

The [`dsh-environment`](../../packages/experimental/environment/README.md) service exposes `ctx.environments`: a registry of provider-contributed execution environments that runs defined functions in them.

## Registry

`EnvironmentInfo` contains a provider-owned `EnvironmentHandle` and a user-facing `displayName`. Handles are non-empty opaque strings and must be unique in one registry; display names may repeat. Providers register metadata together with an `EnvironmentTransport`, retaining connection configuration privately. `list()` returns metadata snapshots; `get(handle)` reads the current registration. The payload-free `environments/change` event fires after each registration and each effective unregistration, so consumers re-read `list()`. Removing a provider withdraws its environments and closes their connections.

The [single SSH](../../packages/experimental/environment-ssh/README.md), [SSH configuration](../../packages/experimental/environment-ssh-config/README.md) and [local](../../packages/experimental/environment-local/README.md) providers use the same protocol. SSH configuration discovery composes the single-SSH provider for concrete aliases and follows changes to the configuration files while it is loaded. Both SSH and local transports start a fresh `daemon.js serve --stdio` process for each new connection; reusing a live channel keeps that process.

## Definitions and runs

`define(fn, options)` binds a self-contained function, its result validation and its origin handlers and returns an `EnvironmentRunner`. Each call of the runner with an environment handle, arguments and a signal runs the function at most once: it resolves the handle's current registration, sends the arguments with the hash of the definition's function source and origin method names, adding the definition itself until the connection's daemon holds it, and validates the returned value through the definition's `result`. Defining contacts no environment. The registry and origin handlers run in dsh. Each run occupies a worker thread of the target execution process, so a function that blocks delays no other run. `EnvironmentContext` belongs to that process and supplies its filesystem, paths, working directory, platform, process execution, signal, limits and typed `origin` methods. Origin calls are restricted to the active run and its owning connection.

Arguments, results and origin values are `EnvironmentValue`s copied by structured clone, so they may carry binary data as `Uint8Array`, `undefined`, dates, maps and sets. `limits.maxMessageBytes`, on the registry and in `EnvironmentContext`, bounds each encoded message; the registry splits messages larger than a frame automatically. A run whose function throws fails with `ENVIRONMENT_RUN_FAILED`, and its `EnvironmentError.remote` holds the thrown error's name, message and string code.

The registry owns the protocol and caches one independent connection per registration; transports own execution-process startup and shutdown. Unsent work can reconnect once; sent runs are never replayed. Cancellation and connection failures do not roll back completed effects. A run in progress never switches to a replacement registration sharing its handle. The [package reference](../../packages/experimental/environment/README.md) owns execution restrictions, trust mechanisms, cancellation and error semantics.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxenvironments--environmentregistry"></a>

### `ctx.environments` — `EnvironmentRegistry`

Owner of environment registrations and of one daemon connection per environment. A connection opens on the first call and reopens on the next call after it closes; runs in flight when it closes fail and are never replayed. Providers contribute metadata and transports; the registry uses one common execution protocol for all of them.

```ts cordis-catalog
/**
 * Admit a provider identifier without interpreting its format.
 * @param value - non-empty stable identifier chosen by the provider.
 * @returns the branded registry key.
 */
handle(value: string): EnvironmentHandle

/**
 * Contribute an environment and its connection capability. Emits `environments/change` once registered.
 * @param info - provider-owned handle and user-facing display name.
 * @param transport - opens channels to this environment's execution process.
 * @returns a disposer that removes this registration, closes its connection and emits `environments/change`;
 * later calls do nothing.
 */
register(info: EnvironmentInfo, transport: EnvironmentTransport): () => void

/**
 * Snapshot the public metadata of current provider contributions.
 * @returns metadata without connection settings or execution objects.
 */
list(): readonly EnvironmentInfo[]

/**
 * Read the current registration's public metadata.
 * @param handle - provider-owned environment identifier.
 * @returns its handle and display name; throws when the environment is unavailable.
 */
get(handle: EnvironmentHandle): EnvironmentInfo

/**
 * Define `fn` for execution processes; each run names its environment. Only its source text and the names of its origin
 * handlers are sent, so `fn` must be a self-contained function or arrow expression without host closures. The type
 * of `fn`'s first parameter determines the arguments of each call. Arguments, results and origin values are copied
 * by structured clone; values it cannot copy, such as functions, fail their run. The own property names of
 * `options.handlers`, read here once, are the `env.origin` methods; names added to the object later are neither
 * exposed nor served, while an origin call looks its handler up on the object when it arrives. The handlers' types
 * determine `env.origin` parameter types and awaited result types. Handlers serve every call and receive only
 * parameters from the function, so host state that belongs to one call, such as a tool call's background job,
 * needs a definition made for that call. Defining neither contacts an environment nor requires a registration.
 * @param fn - daemon-side code receiving each call's arguments and the daemon environment.
 * @param options - result validation and host handlers.
 * @returns a function that runs `fn` at most once per call.
 */
define<A extends EnvironmentValue, T, H extends EnvironmentHandlers = Record<never, never>>( fn: EnvironmentFunction<A, NoInfer<H>>, options: EnvironmentDefineOptions<T, H>, ): EnvironmentRunner<A, T>
```

Source: [`packages/experimental/environment/src/index.ts`](../../packages/experimental/environment/src/index.ts)

<a id="environments-events"></a>

### `environments/*` events

<a id="environmentschange--emit"></a>

#### `environments/change` — emit

The set of registered environments changed. Fires once per registration and once per effective unregistration, after `list()` and `get()` reflect the change; a removed registration's connection is already detached and closing. Payload-free: listeners re-read `list()`. Listener failures are logged and do not undo the change.

```ts cordis-catalog
/**
 * The set of registered environments changed. Fires once per registration and once per effective
 * unregistration, after `list()` and `get()` reflect the change; a removed registration's connection is
 * already detached and closing. Payload-free: listeners re-read `list()`. Listener failures are logged
 * and do not undo the change.
 * @mode emit
 */
'environments/change'(): void
```

Source: [`packages/experimental/environment/src/index.ts`](../../packages/experimental/environment/src/index.ts)
<!-- END GENERATED cordis-surface -->
