# Agent Note: Browser plugin configuration sync

Status: implemented

English | [中文](2026-11-15-client-config-sync.zh.md)

## Problem

Host plugin configuration updates live: when only volatile fields change, the Loader commits the references in place and emits `loader/volatile-update` without remounting the plugin. The browser has no matching path:

| Symptom | Cause |
|---|---|
| A browser plugin's `apply(ctx, config)` always receives an empty config | The page Loader creates entries with `name` only ([entries.ts](../../../../packages/client/modules/src/client/entries.ts)), so the row's `config` in cordis.yml never reaches the browser |
| Packages that need Host configuration each work around it | Some write a page global through `webserver/index-inject`, which takes effect only at page load; others read runtime values through the `configForms` settings mirror |
| The plugin-graph push channel does not meet the rules | `/plugins/events` is an `auth: 'anonymous'` route; the browser has two readers, `EventSource` and `__DSH_TRANSPORT__.fetch`, the latter never reconnects; the frame sequence has no one-complete-snapshot-per-generation rule |

## Decision

### Design principles

| Principle | Content |
|---|---|
| One Config | A plugin has one configuration type, in the package's `src/types.ts`, shared by the Host and Client faces; the schema lives only on the Host face. The browser exports no `Config` and validates no configuration |
| Volatile only | The browser receives only the fields the Host schema declares volatile |
| Secrets removed | `role('secret')` positions inside volatile fields, including inside volatile objects, arrays, and dictionaries, are removed on the Host and never sent. The Host face of `client/modules` implements this itself, without depending on `@deepseek-ai/dsh-settings` |
| Plugins support live updates | A synced configuration change never remounts a browser plugin; the plugin reads references at operation time, or hands them to components as observable sources |
| Equal values do nothing | Every layer compares with deep equality; equal values push, write, and notify nothing, and a reconnect snapshot equal to the current values causes no refresh |
| What is not synced | Host-only ordinary fields, secrets, and per-browser preferences stay out of this path; values the page HTML pre-injects to avoid a first-paint flash, such as the theme, stay as they are |

### Plugin authoring

```ts ignore-check
// src/types.ts — shared by both faces; types only
import type { Volatile } from '@deepseek-ai/cordis'

/** Plugin configuration shared by the Host and Client faces. */
export interface Config {
  /** Host-only ordinary field; never synced. */
  cacheDir: string
  /** Synced to the browser. */
  interactiveByDefault: Volatile<boolean>
  /** Synced as one value. */
  office: Volatile<{ maxBytes: number }>
  /** Volatile but `role('secret')`: stripped on the Host; reads as undefined in the browser. */
  apiKey?: Volatile<string>
}
```

```ts ignore-check
// src/index.ts — Host face; the only schema
export const Config: z<Config> = z.object({
  cacheDir: z.string().default('.cache'),
  interactiveByDefault: z.boolean().default(false).volatile(),
  office: z.object({ maxBytes: z.natural().default(8 << 20) }).volatile(),
  apiKey: z.string().role('secret').volatile(),
})
```

```ts ignore-check
// src/client/index.ts — Client face; no Config export
import type { SyncedConfig } from '@deepseek-ai/dsh-client-config/types'
import type { Config } from '../types.ts'

export function apply(ctx: Context, config: SyncedConfig<Config>): void {
  // Every synced field may read undefined; the plugin decides what an absent value means.
  const tooLarge = (bytes: number) => bytes > (config.office.get()?.maxBytes ?? Number.POSITIVE_INFINITY)
  ctx.slots.register({
    name: 'demo.body',
    inject: (): DemoBodyInjected => ({ hooks: { interactiveByDefault: config.interactiveByDefault }, tooLarge }),
  }, DemoBody)
}
```

```tsx ignore-check
// src/client/DemoBody.tsx — the renderer binds the injected source as useInteractiveByDefault
export function DemoBody({ useInteractiveByDefault, tooLarge }: InjectFace<DemoBodyInjected>) {
  const interactive = useInteractiveByDefault(value => value)
  // ...
}
```

Types exported by the types-only package `@deepseek-ai/dsh-client-config/types`, which plugins depend on instead of the bootstrap Client Modules package; Client Modules implements them:

```ts ignore-check
/** One synced field: Host-aligned `get()`, and directly an observable source for an injected hook. */
export interface SyncedConfigRef<T> extends Volatile<T>, ObservableSnapshot<VolatileSnapshot<T>> {}

/** The Volatile fields of the shared Config type. */
export type SyncedConfig<C> = {
  readonly [K in keyof C as NonNullable<C[K]> extends Volatile<unknown> ? K : never]-?:
    NonNullable<C[K]> extends Volatile<infer V> ? SyncedConfigRef<V | undefined> : never
}
```

`get` and `getSnapshot` return the same frozen snapshot: `get` matches how the Host reads a volatile reference, and `getSnapshot` with `subscribe` satisfy `ObservableSnapshot`, so the reference itself goes into `hooks` without renderer adaptation. The interface has no write operation; the implementing class stays private to Client Modules.

Components follow the [client rules](../../../../packages/client/AGENTS.md): the plugin injects field-level sources in a slot inject's `hooks` compartment, and the component reads them only through the renderer-bound `use<Name>`, never touching the source.

### Ownership

Runtime ownership stays in `client/modules`; the only new package is the types-only `@deepseek-ai/dsh-client-config` (empty `apply` on both faces). `client/modules` already follows Loader entries, composes the plugin graph, and creates entries in the browser; synced configuration is an input of an entry, so it owns this too:

| Face | Responsibility |
|---|---|
| Host (inside the `clientModules` service) | Listens to `loader/volatile-update` on each graph row's own plugin `ctx`; recomputes after the plugin fiber becomes ACTIVE (`internal/status`) or after entry reconciliation; reads the schema's top-level volatile field values from `fiber.effectiveConfig`, removes `role('secret')` positions by the schema, and compares the row's values with the last ones by deep equality, writing them into the graph row's `config` and republishing the graph only when they differ. A change of synced values alone rebuilds no combo artifact |
| Client (inside the entry controller) | Keeps the latest synced values of every package that has appeared in the graph; each plugin activation receives a new configuration object (an empty object while the row has no values), as each Host fiber activation resolves new references; on each graph it compares fields as JSON and writes the changes into the current activation's object |
| Client (`ctx.config` service) | Read-only: `resolveConfigByPackage<C>(packageName)` returns the object a package's current activation received, for reading another plugin's configuration; the object changes when the plugin is replaced, and the result is `undefined` while no activation runs |

Client constraints:

| Constraint | Content |
|---|---|
| Lazy creation | A field reference is created on first access and cached |
| Instance identity | One object per activation, living as long as that activation; code replacement and a re-added row each produce a new object holding the latest values |
| No `entry.update` | Synced configuration never takes the Loader update path, so it never triggers a remount, and the browser emits no `loader/volatile-update`; changes notify only through the field references' `subscribe` |
| Atomic publication | One graph update sets every changed field before notifying their subscribers, as the Host commits every reference before emitting its event |
| No value validation | The authoritative Host schema has already validated the values; the browser checks only that a row's `config` is an object when it parses the graph |
| Delivery | The entry controller registers a prepended `internal/config` listener on the page Loader that returns the synced object for managed entries that export no schema; the Loader's interpolation runs inside it and cannot copy the object. A Client face that exports its own `Config` schema keeps Cordis's ordinary configuration, and fails to activate if its row also carries synced values |

### Ordering

Host consistency comes from two facts: the schema and the code belong to one module, and activation resolves the raw configuration with that schema; code reloads and configuration reloads run serially through Host hot reload, and only an ACTIVE instance receives volatile changes in place. The Client aligns with the second:

| Situation | Host | Client |
|---|---|---|
| Configuration changes while the instance runs | Commits every reference in place, then notifies | Writes into the current activation's object in place, notifying after every field is written |
| Configuration changes while a replacement is queued and teardown has not begun | The instance is still ACTIVE and updates in place | Same |
| Configuration changes after teardown begins | A non-ACTIVE instance no longer updates in place; the new instance resolves the latest configuration | Teardown releases the old activation, whose object receives no further writes; the new activation starts with the latest values |
| The row is removed | The instance is destroyed and receives no configuration | Removal releases the activation; nothing is written while the row is absent from the graph |
| The Host-side plugin instance is not ACTIVE | Not applicable | Values follow the Host's configuration as the Host plugin's own effective Config does, including when activation fails; an instance that has not activated yet publishes the values its own schema resolves from its raw configuration |

A plugin instance that has not activated yet (a new install, an upgrade, a code reload) publishes the values its own schema resolves from its raw configuration, so the graph frame that announces new browser code already carries values of the matching Host schema. Only an incompatible schema change during development (a renamed or removed field) can briefly give old browser code values it does not expect, until the rebuilt bundle arrives.

### Push order

When a Host plugin updates its configuration and then pushes other data to the browser, the browser should receive the configuration first. The order is ensured only at the mechanism level, through the steps below; it is not guaranteed in practice. Each stream's source takes its own number of asynchronous steps between a Host event and the item reaching the Gateway write queue, so a stream with fewer steps can be written first even when no plugin adds a wait of its own. Plugins must not rely on this order:

| Step | Approach |
|---|---|
| Host enqueue | `clientModules` registers its `loader/volatile-update` listener on the plugin ctx with prepend, so it puts the new graph into every follower queue synchronously before the plugin's own listeners run |
| pluginEvents stream | `follow` yields increments from its own generator, with no delegated generator adding a step |
| Gateway write | Each connection has one write queue; each stream's items enter it when the source produces them and are written in queue order, without waiting for the previous write to complete; when the queued bytes exceed `streamOutboxBytes`, the whole connection pauses reading every source |
| Browser handling | WebSocket messages are handled in arrival order, and configuration writes complete synchronously while a graph frame is handled |

### Delivery

First-render values travel in the `__DSH_BOOT__` graph rows; later values travel in the plugin-events stream's `baseline` and `graph` frames, with no separate configuration frame. `@deepseek-ai/dsh-client-modules/types` exports the plugin graph's wire types. Only the owner receives configured values; every other Peer, such as a LiveShare viewer, receives in the boot graph and in every plugin-events frame the values each plugin's schema resolves from an empty Config, so the Host schema remains the only source of defaults and the owner's configured values stay on the Host; a row whose schema rejects an empty Config carries no values there. Remote access policies decide only whether a Peer may follow the graph.

### Push channel

`/plugins/events` becomes the authenticated Typert Remote stream `pluginEvents/follow`, which the browser consumes with `RemoteSnapshotStream`:

| Frame | Content | Browser handling |
|---|---|---|
| `baseline` | The complete plugin graph, including each row's synced configuration | Entry reconciliation |
| `graph` | The complete plugin graph after a structural or synced-configuration change | Entry reconciliation |
| `rebuilt` | `{ id, rev }`, one package's code rebuild | Entry code replacement |

| Item | Content |
|---|---|
| Authentication | Ordinary Remote gateway authentication and authorization; the anonymous `/plugins/events` route is removed, and the browser face opens the stream while Remote access allows `pluginEvents/follow` |
| Transport | Both the `EventSource` and the `__DSH_TRANSPORT__.fetch` readers are removed; shells such as liveshare and webworker connect through the Remote carrier Connection already provides |
| Reconnection | `RemoteStream` owns it; every generation starts with `baseline`, and the new snapshot covers anything missed while disconnected |
| Desktop | Shares the same Remote stream with Web |
| Ownership | The `client/hmr` Host face owns the `pluginEvents` Remote service, in the same package as the bundle stat poll, and declares no `ctx` type merge; `client/modules` is a zero-dependency bootstrap package and takes no typert or gateway dependency |
| Browser dependencies | The browser face `$mount`s its own generated `pluginEvents` namespace rather than through the `api-remotes` assembly, so `api-remotes` can be hot-replaced independently; the required dependencies are `modules`, `remote` (the gateway Client face, over Connection), and `remoteAccess` |

### Scope: existing uses the mechanism can absorb

This Note migrates no existing use; the [migration Note](../../proposed/architecture/2026-11-15-client-config-sync-migration.md) owns the inventory and order. The mechanism can absorb page globals that deliver Host configuration through `webserver/index-inject`, plugins that read runtime values through `configForms`, and `Config` schemas declared only on a Client face that nothing can configure.

## Verification

The following hold and are covered by tests:

- A browser plugin's `apply` `config` holds the Host's current volatile values on first render; after a volatile field in `cordis.patch.yml` changes, the browser reference updates and subscribed components re-render, with neither the browser nor the Host plugin fiber remounted.
- `role('secret')` values in the positions the projection removes, the same as the settings redaction, appear neither in the first-render injection nor in any pushed frame; a non-owner Peer receives only schema defaults, never configured values.
- Host-only ordinary fields never appear in the browser.
- A configuration reload with unchanged values, and the reconnect baseline after a Host restart, emit no `loader/volatile-update` and notify no subscriber.
- No anonymous `/plugins/events` route exists; an unauthenticated request cannot obtain the plugin graph or configuration; after reconnection the browser state matches the Host.
- After code hot reload the new activation receives a new `SyncedConfig` object holding the current values, and the old activation receives no new values once its teardown begins.
- On the Host, the new graph frame enters the pluginEvents follower queues before the plugin's own `loader/volatile-update` listeners run; the order on the wire is not required.
- Tests: unit tests for both faces of `client/modules` (removal, comparison, lazy creation, reference stability, listener registration and removal); a real composition test that boots a profile through the Loader, changes a patch, and asserts browser-visible values; the `client-plugin-live` and `client-config-sync` Web end-to-end tests, including reconnection after a transport restart.

## Alternatives considered

| Rejected | Reason |
|---|---|
| A separate browser `ClientConfig` schema | Two schemas drift; the Host schema already carries volatile declarations and validation |
| Sending the whole configuration with secrets removed | Leaks ordinary fields such as Host paths and URLs to the browser |
| Applying changes to browser entries through `entry.update({ config })` | The browser has no schema, so the Loader cannot tell volatile fields and only remounts |
| Changing the vendored Loader to add a global volatile event | Requires a logged vendor modification; listening on each entry's own `ctx` suffices |
| Placing the channel in `client/modules` | The bootstrap package would depend on typert and the gateway |
| Mounting `pluginEvents` through `api-remotes` | A failed `api-remotes` replacement would cut the plugin update channel |
| Declaring "replacement requires a page reload" for Connection and the gateway | Adds a manifest field and a UI branch; a page reload after a failed replacement is accepted |
| A unified `useConfig` framework hook in the renderer | Adds a framework-level hook; manual `hooks` injection already serves components |
| Reusing the projection and removal functions of `@deepseek-ai/dsh-settings` | The settings architecture will be adjusted after this mechanism, so no dependency yet |
| References that are only `ObservableSnapshot` | Inconsistent with the Host's `get()` on volatile references |
| One page-lifetime configuration object per package | An old instance being torn down during replacement would still receive new configuration, unlike the Host |
| Changing the vendored Loader to emit a commit event for Host enqueue order | A prepended listener already suffices, with no vendor change |
| A separate push channel for configuration | Duplicates the plugin-graph channel's authentication, reconnection, and snapshot semantics |
| A separate `client/config` runtime package with a publicly writable configuration service | Any plugin could rewrite another plugin's configuration, and entries would have to wait for that service by package name |
| Plugins importing the types from `@deepseek-ai/dsh-client-modules/types` | Couples every configured plugin to the bootstrap module-system package and exposes the implementing class |
| Emitting `loader/volatile-update` in the browser too | The field references' `subscribe` suffices; the event requires reaching into Cordis's filter mechanism |

## Consequences

| Risk | Description |
|---|---|
| The channel depends on Connection | Plugin-graph sync depends on Connection and the gateway Client face. Hot-replacing them restarts this plugin and reopens the stream, reconciled by the new generation's baseline; if their new code fails to import or activate, the page receives no plugin updates until it reloads (accepted) |
| Listeners registered on other plugins' `ctx` | The Host face registers on tracked entries' `ctx`; `clientModules` must withdraw every listener when it unloads |
| Self-built references | Client references implement `Volatile` structurally without Cosmokit's internal write protocol, so `isVolatile` does not recognize them |
| Empty configuration objects | Browser plugins without synced fields also receive an empty read-only object as `config` |
| Push order not guaranteed | The configuration-first order holds only when every stream takes the same asynchronous steps from a Host event to the Gateway write queue; streams written in other ways, with or without waits of their own, may be written first |
| Every field may be absent | Each `SyncedConfig` field reads `V \| undefined`: secrets, unprojectable values, and Host values not yet matching the browser code are absent, so plugins handle the absent value at each read |
