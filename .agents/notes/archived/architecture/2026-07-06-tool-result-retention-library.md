# Agent Note: Tool result retention library

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-06-tool-result-retention-library.zh.md)

## Problem

Several model-facing tools already bound the amount of context they return, but each one owns a different local mechanism and vocabulary: bash keeps a tail plus spill files, web search caps source lists, web fetch caps body content, and `glob` / `grep` discovery needs an inline first page while keeping exact omission metadata for the full result set. A single `truncate(text)` helper cannot cover those cases: item tools need item counts and grouping outside the primitive, while text tools need byte budgets and UTF-8-safe head/tail cuts.

The shared abstraction the tools need is **retention**, not generic collection. A caller feeds items or text chunks into a bounded object and later receives the retained content plus exact omission metadata. Tool-specific code still owns business semantics: file grouping, line numbering, exit codes, provider error states, spill files, and model-facing prose. The common library owns only the mechanical question "what did we keep, and what did we omit?"

## Decision

`@deepseek-ai/dsh-output-retention` lives under `packages/util/` (peer to `dsh-brand` and `dsh-timeout`) and owns bounded model-facing output. It is a library of pure classes and functions, **not** a Cordis service or plugin: it takes no `ctx`, registers nothing, holds no cross-call state, and emits no events. Tool packages import it directly when they need bounded output.

The library has two independent retainers:

- `ItemRetainer<T>` handles ordered logical units such as paths, grep matches, or search sources. It supports only `head` retention, while keeping the retainer shape open to additional strategies.
- `TextRetainer` handles byte-oriented text streams such as bash stdout/stderr or web response bodies. It supports `head`, `tail`, and `headTail` retention while preserving UTF-8 boundaries at `finish()`.

Both retainers return a small `PushDecision` after each `push()` so callers can tell whether that unit/chunk was fully retained and whether the accumulated result is now truncated. Omission counts are exact because callers keep feeding every observed item/chunk.

```ts ignore-check
/**
 * How much content the retainer omitted.
 *
 * `unknown` is reserved for callers that omit without a count; the retainers
 * themselves return `none` or `exact`.
 */
type Omitted =
  | { kind: 'none' }
  | { kind: 'exact'; count: number }
  | { kind: 'unknown' }

interface PushDecision {
  kept: boolean
  truncated: boolean
}

/**
 * Final result for ordered logical units.
 */
interface RetainedItems<T> {
  items: T[]
  truncated: boolean
  seen: number
  kept: number
  omitted: Omitted
}

/**
 * Final result for text streams.
 *
 * The returned `text` is safe to send to a formatter; the retainer does not add
 * tool-specific headers, exit markers, XML tags, or recovery instructions.
 */
interface RetainedText {
  text: string
  truncated: boolean
  omittedBytes: Omitted
}
```

### Strategies

Item retention supports a head window. Text retention supports head, tail, and headTail byte windows.

```ts ignore-check
type ItemRetentionStrategy =
  | {
      /** Keep the first `maxItems` units. Use for `glob`, `grep`, and web sources. */
      kind: 'head'
      maxItems: number
    }

type TextRetentionStrategy =
  | {
      /** Keep the first `maxBytes` bytes. */
      kind: 'head'
      maxBytes: number
    }
  | {
      /** Keep the final `maxBytes` bytes. Requires reading to the end. */
      kind: 'tail'
      maxBytes: number
    }
  | {
      /** Keep a stable prefix and suffix, omitting the middle. Requires reading to the end. */
      kind: 'headTail'
      headBytes: number
      tailBytes: number
    }
```

### Tool mapping

`read` is intentionally outside the retention library. Its `read-render` helper owns a file-specific pagination contract: `offset` / `limit`, line numbers, `totalLines`, offset-out-of-range errors, per-line preview truncation, and a selected-output byte cap that can stop scanning mid-window. That is a line-window renderer, not a generic retention primitive. It may share future neutral notice helpers, but it should not pass its already-selected window through `ItemRetainer`.

`FsGlobEntry` and `FlatGrepMatch` below are the intended discovery-tool item shapes, not existing retention-library exports. `FsGlobEntry` is one backend-derived path, and `FlatGrepMatch` is one ungrouped grep match before the backend groups retained matches by file.

`glob` uses `ItemRetainer<FsGlobEntry>` with `{ kind: 'head', maxItems: globMaxResults }` after collecting the full sorted path list. The tool keeps the retained first page inline and may save the full list through the spill seam. Path mapping, skipped candidates, and `incomplete` stay outside the retainer.

`grep` uses `ItemRetainer<FlatGrepMatch>` with `{ kind: 'head', maxItems: grepMaxMatches }` before grouping. The executor parses ripgrep output, maps paths, applies per-line preview truncation, and pushes flat matches. After `finish()`, the tool groups retained matches by file and can save the full match list through the spill seam when the inline result is capped. Grouping is not part of the retainer because the cap is total matches, not files; per-match preview truncation and `incomplete` are also separate from result-level retention.

`bash` can use `TextRetainer` with `tail` or `headTail` and reads to process completion. The bash executor still owns spill files, exit status, signal, timeout, and background-job behavior; the retention helper only replaces ad hoc in-memory head/tail accounting where that behavior is desired. Long-running job ownership remains orthogonal to the [generic long-running tool runtime](2026-06-20-generic-long-running-tool-runtime.md).

`web_fetch` can use `TextRetainer` with `head` or `headTail`, or keep provider-owned body caps when the provider must read and decode internally. Either way, the fetch result's `truncated` remains a provider/tool fact, and the library only supplies retained text and omission metadata.

`web_search` can use `ItemRetainer<WebSearchSource>` with `head`. Current providers often return an array, so this is post-hoc but still standardizes notices.

### Notices

The library exposes a neutral notice shape and a tiny formatter hook, but tools provide the user-facing words. A grep footer says "Narrow the pattern, path, or include"; a web fetch footer says "Fetch a more specific URL or section"; bash may point to a spill file. The retainer cannot know those recovery actions.

```ts ignore-check
interface RetentionNotice {
  scope: string
  strategy: 'head' | 'tail' | 'headTail'
  unit: 'items' | 'bytes' | 'chars' | 'lines'
  limit: number | { head: number; tail: number }
  kept: number
  omitted: Omitted
}

const formatGrepNotice = (notice: RetentionNotice): string =>
  formatRetentionNotice(
    notice,
    ({ kept }) => `Results capped at ${kept}. Narrow the pattern, path, or include to see more.`,
  )
```

The formatter hook is deliberately small: a tool turns a `RetentionNotice` into its own footer text. The helper may standardize omission wording, but it does not own recovery guidance.

`truncated` means the retainer omitted otherwise-available content because of a budget. It does not mean the upstream was incomplete. Tools keep separate fields for permission failures, skipped binary files, provider partial failures, unreadable candidates, invalid UTF-8, and any other "could not inspect" condition.

## Consequences

**What shipped.** `@deepseek-ai/dsh-output-retention` exports `ItemRetainer`, `TextRetainer`, the result types (`RetainedItems`, `RetainedText`), the strategy types (`ItemRetentionStrategy`, `TextRetentionStrategy`), `Omitted`, `PushDecision`, `RetentionNotice`, and the neutral notice helpers `describeOmitted` / `formatRetentionNotice` — with no dependency on Cordis or any tool package. Unit tests cover item-head retention with exact omission counts, text-head retention, text-tail retention, head-tail byte retention, zero budgets, UTF-8 boundary handling (2-, 3-, and 4-byte codepoints and invalid lead bytes at each cut), and unknown omission wording.

**What is documented but not yet migrated.** `glob`, `grep`, `bash`, `web_fetch`, and `web_search` have their mappings documented in the [package README](../../../../packages/util/output-retention/README.md), but not every tool has been migrated onto the library in this change; migration is deliberately separate follow-up work. `read` is documented as intentionally out of scope: its `read-render` line-window contract (`offset`/`limit`, `totalLines`, offset-range errors, per-line preview truncation, a byte cap over the selected window) is not generic retention, and one `Omitted` count cannot represent both sides of a line window.

**Boundaries the library holds.** `truncated` means the retainer omitted otherwise-available content because of a budget; it never means the upstream was incomplete. Tool-specific states — `incomplete`, permission failures, provider partial failures, binary skips, bash spill-path recovery, invalid UTF-8 — stay in tool-domain fields, outside the retainer. When a future change migrates a tool, that package's README and tests must prove the model-facing result text is unchanged except for deliberate notice wording.

**Tradeoffs accepted.** The API deliberately supports only item `head` retention and text `head` / `tail` / `headTail`; windows, grouped budgets, sort-aware caps, and upstream-stop control wait until a second consumer proves the need. Text retention counts bytes for process/body safety, leaving character- and line-level preview budgets as separate tool-owned concerns.

## Alternatives considered

**Post-hoc `truncate(text)` only.** Rejected: it matches Codex's history/tool-output truncation use case but loses item counts, grouping boundaries, UTF-8-safe byte windows, and exact omission metadata.

**One generic `Collector<T>` with pluggable callbacks.** Rejected: it hides the two important resource modes. Logical item retention counts items; text retention counts bytes and preserves UTF-8 boundaries. Separate `ItemRetainer` and `TextRetainer` names make that difference explicit while keeping the API small.

**Put `read` windowing behind `ItemRetainer`.** Rejected: `read` is the only shipped window consumer, and its semantics are file pagination rather than generic retention. A single `Omitted` count cannot represent both sides of a line window, and `read` also carries `totalLines`, offset-range errors, per-line preview truncation, and a byte cap over selected output. Keeping `read-render` tool-owned avoids growing the shared library around one special case.

**Make truncation part of `ToolExecutionResult`.** Rejected: the tool registry would have to understand tool-specific recovery guidance, grouping, line numbering, exit status, and provider semantics. Retention is a library used by a tool's Native renderer; the model-facing projection remains tool-owned while the [canonical value](2026-07-20-canonical-tool-output-contract.md) may retain the complete acquired result.

**Expose limits in every model-facing tool schema.** Rejected as the default: Claude Code's grep exposes `head_limit` / `offset`, but this harness keeps routine budgets as deployment config unless the model genuinely needs pagination control. A future read-like continuation field can be added per tool; it does not belong in the shared retention primitive.
