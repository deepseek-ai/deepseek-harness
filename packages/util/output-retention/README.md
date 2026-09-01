---
description: "Bounded model-facing output for tools that must cap how much context they return: item and text retainers plus a standardized omission footer."
kind: "package-library"
---

# @deepseek-ai/dsh-output-retention

English | [中文](README.zh.md)

## Summary

`dsh-output-retention` bounds how much context a tool returns to the model: a caller feeds items or text chunks into a retainer, then gets back the retained content plus exact omission metadata. `ItemRetainer` caps an ordered list of logical units (paths, matches, sources) at a head budget; `TextRetainer` caps a byte-oriented text stream with head, tail, or head-and-tail windows and keeps UTF-8 boundaries valid at every cut. A standardized omission clause and a notice formatter give tools a consistent "results capped" footer while the tool owns the recovery guidance. The library answers only the mechanical question of what was kept and what was omitted — grouping, line numbering, spill files, and provider error states stay in the tool. It is a dependency-light library that tool packages import directly; a `cordis.yml` cannot load it.

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

Use a retainer wherever a tool must cap how much of its result reaches the model, and report honestly what was dropped. Choose `ItemRetainer` for ordered logical units and `TextRetainer` for byte-oriented streams.

### Bounding a list of items

```ts
import { ItemRetainer } from '@deepseek-ai/dsh-output-retention'

declare const globMaxResults: number
declare const candidates: AsyncIterable<{ path: string }>
const retainer = new ItemRetainer<{ path: string }>({ kind: 'head', maxItems: globMaxResults })
for await (const entry of candidates) {
  retainer.push(entry)          // keep draining past the cap for an exact count
}
const { items, truncated, omitted } = retainer.finish()
```

`push()` reports per item whether it was kept, and `finish()` returns the retained items plus `omitted` — an exact count when the caller kept feeding every observed unit. A search tool can collect the full result set for a spill file while retaining only the first page for the model.

### Bounding a text stream

```text
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'

const out = new TextRetainer({ kind: 'headTail', headBytes: headCap, tailBytes: tailCap })
child.stdout.on('data', (chunk: Buffer) => { out.push(chunk) })
const { text, omittedBytes } = out.finish()
```

`head`, `tail`, and `headTail` count bytes, not characters or lines: a child's pipe and an HTTP body are byte streams. `finish()` trims a partial codepoint at each cut, so the returned text never carries a replacement character introduced by the cut, and a codepoint is never reconstructed across the omitted middle.

### Building the omission footer

```ts
import { formatRetentionNotice } from '@deepseek-ai/dsh-output-retention'

declare const grepMaxMatches: number
declare const items: { length: number }
import type { Omitted } from '@deepseek-ai/dsh-output-retention'

declare const omitted: Omitted

const footer = formatRetentionNotice(
  { scope: 'grep', strategy: 'head', unit: 'items', limit: grepMaxMatches, kept: items.length, omitted },
  ({ kept }) => `Results capped at ${kept}. Narrow the pattern, path, or include to see more.`,
)
```

The library standardizes the omission clause (`Omitted 3 items.`) and joins it with the tool's own recovery guidance; only the tool knows the recovery action, so the tool supplies those words.

### What `truncated` means

`truncated` is a budget fact: the retainer omitted otherwise-available content because of a cap. It never means the upstream was incomplete — permission failures, skipped binary files, provider partial failures, and unreadable candidates stay in tool-domain fields, never folded into `truncated`.

### How the current tools use it

| Tool | Retainer | What the tool still owns |
|---|---|---|
| `glob` | `ItemRetainer`, `head` | Spill-file collection, path mapping, skipped candidates, `incomplete` |
| `grep` | `ItemRetainer`, `head` | Spill-file collection, per-match preview truncation, grouping, sorting |
| `bash` | `TextRetainer`, `tail` or `headTail` | Spill files, exit status, signal, timeout, background jobs |
| `web_fetch` | `TextRetainer`, `head` or `headTail` | Provider and resource caps, error states |
| `web_search` | `ItemRetainer`, `head` | The "sources capped" notice wording and provider facts |

`read` stays outside this library: its line-window pagination (`offset`/`limit`, line numbers, `totalLines`) is a file-specific renderer that a single omission count cannot represent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The library is built on one separation: it owns the mechanical question of what was kept and what was omitted; tool packages own every business meaning.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `ItemRetainer`, `TextRetainer`, `describeOmitted`, and `formatRetentionNotice` |
| — | No runtime invariant companion is published; this pure utility owns no event stream or mutable runtime data; its value algebra is enforced by unit tests. |

### Two retainers, two resource models

`ItemRetainer` bounds ordered logical units and keeps only the first `maxItems`; the caller keeps pushing every observed unit so the omission count is exact. `TextRetainer` bounds bytes with one shared prefix/suffix accumulator: `head` is prefix-only, `tail` is suffix-only, `headTail` is both, and the accumulator holds at most `headBytes + tailBytes + one chunk` in memory, so a large stream does not accumulate unbounded.

### How the budget facts stay honest

`push()` returns `kept` (this unit or chunk fully retained) and `truncated` (anything dropped yet). `finish()` reports omission against the bytes actually returned, so a UTF-8 boundary trim that drops partial-codepoint bytes is counted too — a notice built from the budget alone would overstate the retained text. `describeOmitted` prints a count only for `exact`; `unknown` prints no count because the caller provided none.

### The read-render exclusion

`read`'s `offset`/`limit` pagination is a line-window renderer with its own byte cap over the selected window; a single `Omitted` value cannot represent both sides of that window, so it stays out of this library.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the consumers or the boundary decision behind the library.

- [Tool-result retention library Agent Note](../../../.agents/notes/implemented/architecture/2026-07-06-tool-result-retention-library.md) — the boundary the library draws around tool semantics.
- [Spill policy](../../spill/spill-policy/README.md) — composes `TextRetainer` for a bounded preview around a spill-file notice.
- [Spill subsystem](../../../docs/subsystems/spill.md) — the spill vocabulary this library's preview mechanics serve.
- [File search tool](../../fs/tool-fs-search/README.md) — an `ItemRetainer` consumer collecting full results for spill.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the retention consumers that render retained content and omission metadata.

#### KV Cache effect

No direct invalidation; the retention consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the retainers deliberately do not cover. They are current package constraints, not a task backlog.

- **Item retention supports `head` only** — tail, head/tail, pagination, grouping, and provider-completeness semantics remain tool-owned.
- **Text retention is byte-oriented** — line and character windows such as `read` pagination require a separate renderer, and a cut may discard partial UTF-8 boundary bytes to keep the returned text valid.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
