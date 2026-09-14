---
description: "Immutable append-only lists for projection state, with bounded append copying, insertion-order iteration, and Zod checkpoint validation."
kind: "package-library"
---

# @deepseek-ai/dsh-chunked-list

English | [中文](README.zh.md)

## Summary

`dsh-chunked-list` lets callers append values while retaining earlier list versions without copying the whole collection. Callers can iterate every value in insertion order and validate JSON checkpoints with their own value schema. The subagent catalog uses it for immutable projection state.

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

Use this list when an append-only collection needs immutable versions and JSON-compatible storage. An empty list is `undefined`; appending returns a new head without modifying existing nodes. The list shares stored values by reference, so callers must treat them as immutable.

```ts
import { appendChunkedList, iterateChunkedList } from '@deepseek-ai/dsh-chunked-list'

const first = appendChunkedList(undefined, 'first')
const second = appendChunkedList(first, 'second')
console.log([...iterateChunkedList(second)])
```

The example produces `['first', 'second']`; `first` still contains only its original value. `chunkedListSchema(valueSchema)` validates JSON checkpoints and rejects unknown fields, invalid values, and empty or oversized chunks. Use `.optional()` on the schema when the containing field also permits an empty list. See the [source contracts](src/index.ts) for the operations.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The newest chunk stores up to 64 values. Appends copy at most that chunk and share older nodes, taking bounded O(1) work. The capacity controls storage layout, not total list length. Iteration visits all N values in O(N) time and uses O(N / 64) scratch space to visit chunks from oldest to newest. A single capacity constant governs append rollover and recursive Zod validation.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Persistent list operations and checkpoint validation |
| [`tests/chunked-list.spec.ts`](tests/chunked-list.spec.ts) | Version isolation, ordering, structural sharing, and checkpoint acceptance |

No runtime invariant companion is published because this library has no independently changing observations; its operations return caller-owned immutable values.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Utility package map](../README.md) — shared primitives.
- [Subagent catalog decision](../../../.agents/notes/implemented/architecture/2026-09-01-parent-owned-subagent-catalog.md) — why projection state uses chunks.

-----

<a id="model-experience"></a>
## Model Experience

None, as this collection registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Append-only access** — callers needing removal or random access need another collection.
- **Recursive checkpoints** — JSON serialization and schema validation remain subject to runtime nesting limits. Stored values must themselves support the caller's serialization format.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
