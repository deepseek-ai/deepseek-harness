---
description: "Lossless JSON validation, detached snapshots, deep freezing, structural equality, and exhaustive-union helpers for runtime packages."
kind: "package-library"
---

# @deepseek-ai/dsh-util-values

English | [中文](README.zh.md)

## Summary

Callers can validate lossless JSON, read streamed arguments, detach a JSON snapshot, freeze a published value, compare JSON-compatible data, or terminate an unreachable branch without importing a capability package. Each streamed call uses its own `PartialArguments` reader; `PartialArguments.EMPTY` is a shared sealed view with no fields.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Validate or snapshot JSON data

Use `isJsonValue()` for a predicate and `snapshotJsonValue()` when the caller also needs a detached copy. Both accept only lossless JSON roots: `null`, booleans, finite numbers other than negative zero, strings, dense intrinsic arrays, and plain or null-prototype records with enumerable string keys. Cycles, sparse arrays, symbol or non-enumerable own properties, functions, and class instances are rejected.

```ts
import { isJsonValue, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

declare const input: unknown

if (!isJsonValue(input)) throw new TypeError('expected lossless JSON')
const snapshot = snapshotJsonValue(input) as JsonValue
```

### Read streamed arguments

`PartialArguments` reads a JSON object's top-level fields lazily. `append()` retains separate fragments without scanning or concatenating them. Readers index new key/value ranges, skipping unrequested contents; only requested strings are decoded or counted, and only requested complete non-string values are parsed. `complete()` reports a closing delimiter, not validated contents; `invalid` reports errors already discovered by indexing or content reads. It is not a substitute for tool-input validation.

`refresh()` reports changes to previously observed answers at publication time; intervening reads do not acknowledge pending changes. It evaluates content before comparing completion, so decoding errors cannot suppress a completion update. String readers provide decoded text, bounded prefixes, and exact UTF-16 length, with optional step and offset for change detection. `settle(finalText)` compares fragments directly against the complete text: equal input seals the same view and retains its caches; missing or conflicting deltas produce a new sealed view. `fromText()` and `fromObject()` also create sealed views that reject appends. `isSealed` reads that append restriction without scanning or observing content; `closed()` also covers a closed outer object or failed indexing. See [the readers](src/partial-json.ts) for return distinctions.

### Publish, compare, or retain keyed values

`deepFreeze(value)` freezes an object graph in place and returns the same value. It walks enumerable string-keyed children and deliberately leaves live `AbortSignal` objects mutable. `deepEqualJson(a, b)` compares JSON-compatible arrays and records structurally; callers must validate hostile or unconstrained values before comparison.

`WeakMapWithValues<Key, Value>` combines weak object-key lookup with a strongly retained, insertion-ordered `values` set. Each value belongs to one key. The owner must call `delete(key)` or `clear()` at the corresponding lifecycle boundary; the collection does not perform automatic cleanup.

### Close a discriminated union

Use `assertNever(value, context?)` in the default branch of a closed discriminated union. A newly added variant then fails TypeScript compilation at every exhaustive switch, while a runtime value that escaped its declared type throws with the optional context label.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The JSON validator uses an explicit work stack and tracks only the active ancestor chain, so deeply nested values do not consume the JavaScript call stack and repeated non-cyclic references remain valid. Intrinsic arrays and plain objects are recognized across JavaScript realms using native constructor representations from the running engine. Snapshot writes use own data properties, including for names such as `__proto__`. Value operations derive their result only from their arguments; `WeakMapWithValues` stores only instance-owned associations.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | JSON value type, validation and snapshot traversal, structural equality, deep freezing, weak-key/strong-value associations, and exhaustive-union failure |
| [`src/partial-json.ts`](src/partial-json.ts) | Lazy top-level argument scanning and observed-answer change detection |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Utility package map](../README.md) — adjacent stateless helpers.
- [Session subsystem](../../../docs/subsystems/session.md) — durable events that require lossless JSON.
- [Tools subsystem](../../../docs/subsystems/tools.md) — schema validation and canonical tool results built on `JsonValue`.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **`deepEqualJson` assumes JSON-compatible inputs** — it is not a general object comparator and does not define semantics for prototypes, symbols, accessors, cycles, maps, or sets.
- **`deepFreeze` follows enumerable string-keyed children** — it does not turn arbitrary host objects into immutable data, and it intentionally skips live `AbortSignal` instances.
- **`WeakMapWithValues` requires explicit cleanup and unique values** — values remain strongly held until their owning key is deleted or the collection is cleared, and one value must not be shared by several keys.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
