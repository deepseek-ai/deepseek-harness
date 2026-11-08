---
description: "Dependency-free HarnessError base class whose stable code lets tool results, retries, and replay route failures."
kind: "package-library"
---

# @deepseek-ai/dsh-error

English | [中文](README.zh.md)

## Summary

`dsh-error` holds `HarnessError`, the base class for every expected Harness failure. A `HarnessError` carries a stable machine-routable `code` beside its human-readable `message` and optional `cause`, and its `name` is the constructing class name. The tool registry records `name` and `code` of a thrown `HarnessError` on `tool/result`, so retry policy, UI, replay, and analytics route on the code instead of parsing text. The package has no dependencies, so packages below `dsh-llm` in the dependency graph can extend the base too; `dsh-llm` re-exports the same class.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Extend `HarnessError` with one class per owning package or domain and give each failure a stable `UPPER_SNAKE_CASE` code:

```ts
import { HarnessError } from '@deepseek-ai/dsh-error'

export class ArchiveError extends HarnessError {}

throw new ArchiveError('archive entry is missing', 'ARCHIVE_ENTRY_NOT_FOUND')
```

Assign `this.name` a string literal in a subclass constructor when a bundler could rename the class, because `name` is persisted. Import the class from `@deepseek-ai/dsh-error` or from its `@deepseek-ai/dsh-llm` re-export; both name the same class, so `instanceof` checks agree. The [error class and code guide](../../../.agents/skills/dsh-error-handling/references/error-codes.md) defines class choice, naming, and code conventions.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `HarnessError` base class |

### Why it stays dependency-free

`dsh-llm` depends on lower packages such as `dsh-attachment` and `dsh-typert-protocol`, so a base class defined there could not be extended below it without a dependency cycle. Keeping the class in a package without dependencies lets every package extend it; the [decision note](../../../.agents/notes/implemented/architecture/2026-11-05-harness-error-dependency-free-base.md) records the relocation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tools subsystem](../../../docs/subsystems/tools.md) — how the registry records `ToolErrorInfo` from a thrown `HarnessError`.
- [Error-handling rules](../../../.agents/skills/dsh-error-handling/SKILL.md) — when code must throw a `HarnessError`.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
