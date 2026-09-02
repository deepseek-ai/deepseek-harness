---
description: "Nominal string and number types with stateless constructors for packages that own confusable domain values."
kind: "package-library"
---

# @deepseek-ai/dsh-brand

English | [中文](README.zh.md)

## Summary

`dsh-brand` makes structurally identical strings or numbers non-interchangeable at the type level: a `SessionId` cannot be passed where a `ToolCallId` is expected, and an event sequence cannot be passed where a log offset is required. `brandString<T>()` and `brandNumber<T>()` apply nominal brands without shared runtime state, so owning packages can define domain types without importing an unrelated capability.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Brand a domain value when it crosses a package boundary and could plausibly be confused with another value represented by the same primitive; not every string or number needs a brand. A branded value is a contract for TypeScript callers: it enters only functions that expect its domain, and a different brand is rejected at compile time.

### Branding a string

Declare the branded type in the owning package and apply it at the point where that package admits a string:

```ts
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

export type SessionId = Branded<'SessionId'>

const sessionId = brandString<SessionId>('session-1')
```

`brandString()` changes only the static type and performs no runtime validation. Validate domain grammar before calling it when the owning type has one. Once branded, the id compares, logs, serializes to JSON, and crosses the wire as an ordinary string.

### Branding a number

Declare a numeric brand in its owning package and apply it only after that package admits the number:

```ts
import { brandNumber, type BrandedNumber } from '@deepseek-ai/dsh-brand'

export type SessionSeq = BrandedNumber<'SessionSeq'>

const seq = brandNumber<SessionSeq>(7)
```

`brandNumber()` returns the original number and performs no validation. The owning package validates requirements such as non-negative safe-integer range before branding. Comparison, arithmetic, logging, JSON serialization, and wire transport retain ordinary number behavior; arithmetic produces an unbranded number that the owner must admit again before it re-enters the domain.

### When to brand

Brand values that cross package boundaries and could plausibly be confused — `ToolCallId` in `dsh-llm`, the shared agent/session `SessionId` in `dsh-session`, `JobId` in `dsh-jobs`, and `SessionSeq` versus `SessionLogOffset` in `dsh-session`. Values that stay local or cannot be confused do not need this abstraction.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package defines two intersection types, `string & { readonly [BRAND]: B }` and `number & { readonly [BRAND]: B }`, where `BRAND` is a module-private `unique symbol`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Branded string and number types with stateless constructors |
| — | No runtime invariant companion is published; this pure utility owns no event stream or mutable runtime data; its value algebra is enforced by unit tests. |

### How values stay portable

The private symbol never exists at runtime: TypeScript erases it, so branded values have no tag or prototype. `brandString()` and `brandNumber()` return their inputs unchanged. Separate installed copies therefore produce interchangeable values without sharing a registry or constructor identity.

### Why it stays dependency-free

Keeping these helpers in their own package means `dsh-jobs` can brand `JobId` without importing an unrelated capability package, while each capability still owns the meaning and validation of its concrete ids.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the values these primitives brand or the type conventions around them.

- [Core subsystem](../../../docs/subsystems/core.md) — where the shared `SessionId` brand and the type rules are documented.
- [LSP subsystem](../../../docs/subsystems/lsp.md) — `LspProviderId`, a branded provider id built on this primitive.
- [Jobs package](../../jobs/jobs/README.md) — the `JobId` brand owned by the jobs capability.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
