---
description: "Lossless JSON validation, detached snapshots, deep freezing, structural equality, and exhaustive-union helpers for runtime packages."
kind: "package-library"
---

# @deepseek-ai/dsh-util-values

English | [中文](README.zh.md)

## Summary

`dsh-util-values` gives runtime packages one implementation for lossless JSON values, immutable object graphs, structural JSON equality, and exhaustive closed-union failures. Callers can validate untrusted values, detach a JSON snapshot, freeze a published value, compare JSON-compatible data, or terminate an unreachable branch without importing a capability package. The helpers hold no shared registry, constructor identity, or mutable module state.

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

### Publish or compare values

`deepFreeze(value)` freezes an object graph in place and returns the same value. It walks enumerable string-keyed children and deliberately leaves live `AbortSignal` objects mutable. `deepEqualJson(a, b)` compares JSON-compatible arrays and records structurally; callers must validate hostile or unconstrained values before comparison.

### Close a discriminated union

Use `assertNever(value, context?)` in the default branch of a closed discriminated union. A newly added variant then fails TypeScript compilation at every exhaustive switch, while a runtime value that escaped its declared type throws with the optional context label.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The JSON validator uses an explicit work stack and tracks only the active ancestor chain, so deeply nested values do not consume the JavaScript call stack and repeated non-cyclic references remain valid. Snapshot writes use own data properties, including for names such as `__proto__`. The other helpers derive their result only from their arguments and retain no state between calls.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | JSON value type, validation and snapshot traversal, structural equality, deep freezing, and exhaustive-union failure |
| — | No runtime invariant companion is published because these value operations have no shared runtime state; unit tests cover their algebra. |

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

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
