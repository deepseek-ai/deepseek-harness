---
description: "Nominal string types and stateless constructors for packages that own identifiers crossing package boundaries."
kind: "package-library"
---

# @deepseek-ai/dsh-brand

English | [中文](README.zh.md)

## Summary

`dsh-brand` makes structurally identical strings non-interchangeable at the type level: a `SessionId` cannot be passed where a `ToolCallId` is expected even though both are plain strings at runtime. `brandString<T>()` applies a nominal brand to one domain-owned string without shared runtime state and lets capability packages own their concrete id types without importing an unrelated capability.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Brand the ids a package owns when they cross a package boundary and could plausibly be confused with another package's ids; not every string needs a brand. A branded id is a contract for TypeScript callers: it only ever enters the functions that expect it, and an id from another package is rejected at compile time.

### Branding a string

Declare the branded type in the owning package and apply it at the point where that package admits a string:

```ts
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

export type SessionId = Branded<'SessionId'>

const sessionId = brandString<SessionId>('session-1')
```

`brandString()` changes only the static type and performs no runtime validation. Validate domain grammar before calling it when the owning type has one. Once branded, the id compares, logs, serializes to JSON, and crosses the wire as an ordinary string.

### When to brand

Brand ids that cross package boundaries and could plausibly be confused — `ToolCallId` in `dsh-llm`, the shared agent/session `SessionId` in `dsh-session`, `JobId` in `dsh-jobs`, `LspProviderId` in `dsh-lsp`. Strings that never leave their owning package do not need this abstraction.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The primitive is one intersection type: `string & { readonly [BRAND]: B }`, where `BRAND` is a module-private `unique symbol`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Branded string type and its stateless constructor |
| — | No runtime invariant companion is published; this pure utility owns no event stream or mutable runtime data; its value algebra is enforced by unit tests. |

### How values stay portable

The private symbol never exists at runtime: TypeScript erases it, so branded values have no tag or prototype. `brandString()` returns its input unchanged. Separate installed copies therefore produce interchangeable values without sharing a registry or constructor identity.

### Why it stays dependency-free

Keeping these helpers in their own package means `dsh-jobs` can brand `JobId` without importing an unrelated capability package, while each capability still owns the meaning and validation of its concrete ids.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the ids this primitive brands or the type conventions around it.

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
