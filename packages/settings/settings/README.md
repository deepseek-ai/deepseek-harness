---
description: "The user-settings service for plugin authors and maintainers registering configurable namespaces, reading resolved values, or wiring configuration surfaces."
kind: "package-reference"
---

# @deepseek-ai/dsh-settings

English | [中文](README.zh.md)

## Summary

Use this package when users must change a plugin's configuration at runtime without restarting or rereading `cordis.yml`. Each namespace combines schema defaults, deployment configuration, and user overrides; readers receive a deep-frozen resolved snapshot and can observe committed changes. Writes affect only user overrides, are serialized per namespace, and may reject stale revisions instead of overwriting newer changes. Durable runtime edits require configured settings storage; without it, the plugin continues with its composed configuration.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Plugins and configuration surfaces use `ctx.settings` to read and change configuration at runtime. The common path: mount a provider, register a namespace with a schema, read and watch the resolved value, and write through the owner scope.

### When to choose it

Choose settings when a plugin's configuration should be changeable at runtime — by the user editing a document or by a configuration UI — without restarting or re-reading `cordis.yml`. It fits when several plugins each own one configuration namespace, and when a configuration surface must render schemas, mark user-overridden fields, and persist edits. It is unnecessary when configuration is fixed at load time: without a provider mounted, nothing changes and configuration stays exactly as composed.

### Mounting a provider

The service stores nothing by itself; mount a provider such as the shipped file-backed one:

```yaml
- name: '@deepseek-ai/dsh-settings-file'
  config:
    path: /absolute/path/to/settings.yaml
```

`ctx.settings` appears once the provider is live. The provider README owns the full configuration surface; the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-settings-file) lists every accepted field.

### Registering a namespace

A plugin registers its own namespace with a schemastery schema, optionally supplying the composition entry as the `base` layer so the resolved value starts from what the deployment already configured:

```text
const scope = ctx.settings.register('ui-theme', ThemeSchema, {
  base: config,   // composition entry config; the user layer resolves above it
})
const theme = scope.get()              // deep-frozen resolved snapshot
scope.update({ density: 'compact' })   // merges into the user section and persists
```

Literal namespace arguments are checked by TypeScript against the lowercase letter, digit, and hyphen grammar; dynamically supplied strings receive the same validation at runtime. `ctx.settings.installSection(owner, ns, schema, entry, hooks)` packages the optional-service wiring for a consumer plugin: while a settings service exists it registers the namespace with the plugin's composition entry as `base`; when the service goes away the plugin falls back to its entry config and keeps working exactly as composed.

### Reading and observing values

`get(ns)` returns the resolved value as a deep-frozen snapshot, `undefined` while the namespace is unregistered. `watch(callback)` invokes the callback after each committed change with `(next, prev)`: invocations of one callback run one at a time in commit order, and failures are contained and logged, so a slow or throwing observer never blocks or breaks other observers.

### Writing values

`update(ns, patch)` deep-merges a plain-object patch into the user section only — never into `base` — validates the resolved candidate, persists through the provider, then commits. `replace(ns, section)` sets the user section wholesale, which is the removal/reset path: `replace({})` re-inherits `base` and schema defaults. `mutate(ns, ops)` applies ordered `{ op: 'set' | 'unset', path }` edits to the section as it stands when the write reaches the front of the queue — the removal path for a caller holding an incomplete (for example redacted) view, because rebuilding a section from what a wire surface returned and replacing it wholesale would delete every field the wire never sent back.

Every write rejects non-JSON-compatible data (a `Date`, `Map`, `BigInt`, non-finite number, or circular reference fails with its `$`-rooted path before anything persists), rejects on a read-only provider, and accepts an optional `expectedRevision`: pass back the `revision` from a descriptor, and a namespace that moved past it refuses the write with `SettingsConflictError` instead of overwriting the writer that landed first.

### Configuration surfaces

`describe()` returns one descriptor per registered namespace: the serialized schema, the resolved value, the detached `base` and `user` layers (a field's presence in `user` marks it user-overridden), the effect timing, and the namespace's revision. Pass `redactSecrets: true` on every wire surface: it strips `role('secret')` fields from every layer and enumerates them as `{ path, set }` slots so a page can render write-only inputs without ever receiving a secret. `documentPath` and `prepareDocument()` expose the provider's user-editable file to a native editor when one exists.

### Events and failures

`settings/updated (ns, next, prev, source)` fires after each committed change — an in-process write (`source: 'update'`) or an externally observed edit (`source: 'provider'`) — and never when the resolved value is deep-equal. `settings/document-updated (ns, revision)` fires whenever the raw user section changed, even when the resolved value did not, which is what an open editor needs to learn that a field went from inherited to overridden. A stored section the schema rejects keeps the namespace's last good value and warns on reload; at registration the same failure rejects the registration itself.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Layered resolution, single user layer.** A namespace's value is schema defaults, then the registrant's composition `base`, then the user document section; writes touch only the user layer, so `replace({})` is a true reset.
- **Commits are deep-equal gated.** `settings/updated` fires only when the resolved value moved; the raw-section event is separate because configuration surfaces must also learn "inherited became overridden".
- **Writes are queued and revision-checked.** Per-namespace write queues serialize in call order, and `expectedRevision` is judged at the front of the queue, where the service can tell a fresh writer from one holding a stale snapshot.
- **Observer and listener failures are contained.** Watcher invocations and event fan-out isolate sync throws and async rejections so one broken observer cannot wedge commits or a provider's reload loop; `INVARIANT`-coded failures rethrow after every listener ran.
- **Registrations are fiber effects.** Registering a namespace is an effect on the calling plugin's fiber: disposing that fiber removes the namespace and its observers.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition: namespace validation, registration, resolution, write queue, describe/redaction, events, `installSection` |
| [`src/redact.ts`](src/redact.ts) | `redactSecrets` walker: strip `role('secret')` fields and enumerate their slots |
| [`src/types.ts`](src/types.ts) | Client-safe type surface: event declarations, `SettingsNamespace`, `SettingsUpdateSource` |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: `settings/updated` fires only for a registered namespace, only on a resolved-value change, with the authoritative value |

### Resolution and write paths

Each write snapshots its input at call time (detaching and validating JSON-shaped data), then queues on the namespace's serialized chain. At the front of the queue the service re-reads the section as it stands, checks `expectedRevision`, merges/replaces/mutates, resolves and validates the candidate through the schema plus the owner's optional `validate`, persists through the provider, and only then commits and emits. A write whose registrant fiber was disposed mid-flight still reaches storage but commits and notifies nobody; teardown refuses new writes and drains queued writes and started watcher invocations before disposal completes.

### Change detection and events

`commit` compares resolved values with the seam's `deepEqualJson` predicate and fans `settings/updated` out one listener at a time. `bumpRevision` compares raw sections and emits `settings/document-updated` with the new revision; it runs independently of the resolved-value check. Both fan-outs contain listener failures the same way.

### Client-safe types

The `./types` subpath export holds the event declarations together with the `SettingsNamespace` and `SettingsUpdateSource` types their signatures name, and the package root re-exports those types. A consumer outside the Host compilation face reads the exact signature the Host emits instead of restating it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the service-level contract is not enough. They move from the shared subsystem vocabulary to the shipped provider and the capability architecture.

- [Settings subsystem reference](../../../docs/subsystems/settings.md) — namespaces, registration, owner scope, descriptors, change commits, and the generated cordis surface.
- [File-backed settings provider](../settings-file/README.md) — the shipped YAML/JSON provider: configuration, hot reload, comment-preserving writes.
- [Settings package map](../README.md) — the two packages of the user-settings capability and their roles.
- [Capability seams](../../../docs/capability-seams.md) — the Service Definition / Service Provider / Consumer split this service follows.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through consumer plugins, which own any model-facing content fed by a settings value; the service only stores and resolves user settings and registers nothing model-facing itself.

#### KV Cache effect

No direct invalidation; a consumer that folds a settings value into the request prefix owns that change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the service is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **Single user layer** — resolution knows schema defaults, one composition `base`, and one user document; it does not record which layer supplied each resolved value.
- **`redactSecrets` is not a proven wire boundary** — the walker follows `object`/`dict`/`array` containers, so a `role('secret')` field reachable only through a union, intersection, or transform is returned verbatim with an empty `secrets` list, and the serialized schema carries a secret field's default to every client. Neither case is rejected; a schema whose secrets are not reachable through the walked containers must not be registered on a wire-exposed namespace. A fail-closed `describeForWire()` — one that refuses a schema it cannot prove safe and sanitizes the serialized envelope and error text — is the deferred answer.
- **Cross-process concurrency is provider-defined** — the service serializes writes per namespace in-process only; concurrent processes converge by provider behavior (the file provider read-modify-writes under a writer lock, so namespaces survive concurrent writers and same-namespace conflicts resolve last-write-wins).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above and the package code. Open directions, tracked in code TODOs: rename the public `ns` parameter to `namespace` across the API, provider contract, implementations, tests, and consumers; deactivate watchers and await their tails on registration disposal so callbacks cannot outlive the registrant fiber; re-resolve a replacement registration from its persisted section so an in-flight old write cannot leave it stale; and use property-safe object construction so valid JSON keys such as `__proto__` remain own data. The fail-closed `describeForWire()` sanitizer is the deferred answer to the redaction limitation above.

</details>
