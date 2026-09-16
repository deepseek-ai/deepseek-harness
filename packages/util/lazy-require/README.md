---
description: "Caller-relative lazy loading for CommonJS-compatible Host dependencies whose initialization is not needed during application startup."
kind: "package-library"
---

# @deepseek-ai/dsh-lazy-require

English | [中文](README.zh.md)

## Summary

`dsh-lazy-require` keeps a CommonJS-compatible Host dependency unloaded until its first real operation. Resolution remains relative to the consuming package, and one successful module value is reused for the rest of the process realm.

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

Pass the dependency's literal specifier and the caller's `import.meta.url`:

```ts
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

interface NativeModule { open(): void }
const requireNative = createLazyRequire<NativeModule>('native-package', import.meta.url)
```

Calling `requireNative()` loads the dependency once. A failed load is not cached.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The utility creates Node's `require` from the supplied caller URL and caches only a successful return value. The explicit caller URL preserves package-local dependency resolution after publication.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Caller-relative loader and successful-result cache |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Utility package map](../README.md) — adjacent shared primitives.
- [NPM release sequences](../../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md) — published dependency classification and first-use loading policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as this Host utility registers no model-facing behavior.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **CommonJS-compatible dependencies only** — ESM-only packages require an asynchronous factory owned by their caller.
- **WebWorker packaging needs an explicit request** — the static packer does not discover dependencies named only in `createLazyRequire()` calls. A package used in a Preview image must keep the dependency reachable through a supported literal request until the packer recognizes this helper.

No runtime invariant companion is published because the loader holds no independently observable mutable relationship.

<a id="dev-note"></a>
### Dev Note

None.
