# Agent Note: Incremental tool-argument scanning and argument order during preparation

Status: implemented

English | [中文](2026-09-24-preparing-tool-arguments.zh.md)

## Problem

[Three-stage tool calls](2026-09-22-tool-call-three-phases.md) make tool identity visible before `tool/call`. A raw argument prefix alone cannot supply field-aware presentation: write/edit need a complete path and decoded content length, while bash/run_code need the description before the command or program finishes streaming.

The order in which the model generates arguments also decides what can appear first. On 2026-09-24, 310 controlled requests against the real DeepSeek V4 API exercised bash/run_code/write/edit:

| Variant | Change | bash first key is description | run_code first key is description |
|---|---|---|---|
| Baseline | — | 0/20 | 1/20 |
| `properties` order only | description moved first | 0/20 | 0/20 |
| `properties` + `required` together | Same plus reordered `required` | Forced tool_choice 10/10; free calling Pro 7/10, Flash 0/10 | Forced 10/10; free 20/20 |
| Together + one ordering instruction in the description text | Appends "Provide `description` before `command` in the arguments." | Free calling Flash 19/20, Pro 20/20 | 20/20 |

In these samples, reordering `required` changes argument order where reordering `properties` alone does not; V4 Flash's free bash calls also need the explicit instruction. The `dsh-tools` schema DSL generates `required` in property declaration order, so changing the declaration order in source reorders both. The probe uses a minimal system prompt, not the complete Harness prompt.

## Decision

### A lazily computed argument view lives in `dsh-util-values`

`PartialArguments` is a tool-independent lazy reader. It retains separate argument fragments and a top-level key/value range index, or borrows an already parsed PTC payload. Reads index only newly received boundaries; unrequested values are neither decoded, counted, nor parsed. Requested fields materialize from their own ranges, without a per-tool field specification or registry.

The boundary scanner tracks quotes, backslash parity, and matching nested brackets across fragments. Key names are decoded for lookup, while value contents are deferred. `complete()` reports a closing delimiter, not validated content; `invalid` reports errors already found by indexing or a content read. Content errors do not prevent indexing subsequent fields. Formal tool-input validation remains outside this presentation reader.

Requested unescaped lengths derive directly from offsets. Escaped strings maintain content cursors only for requested length, text, or bounded-prefix reads; a limit query stops once its answer is known. Closed strings use native decoding when their full text is first requested. Arbitrary late reads require retaining the original fragments until authoritative complete text replaces them.

The view judges change itself: `append(delta)` only retains the fragment, and `refresh()` compares remembered answers at publication time. With nothing read yet, it does not scan or report a change. Only refresh advances an existing answer's comparison baseline; an intervening read cannot suppress another consumer's update. The business states its granularity as it reads: `stringLength('content', { step: 1024 })` makes only a kilobyte crossing count, `text('description')` makes every character count, and `textPrefix()` limits decoded text to the requested UTF-16 prefix. An `offset` includes completed strings when edit progress combines old and new text.

### Parsing happens in the Tool Definition, not in React

The [Tool Definition](../../../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts) matches every `tool-call-delta` carrying an id as a start candidate: the earliest opens the Context whether or not it is named, later ones fold as updates. The named delta creates the preparing root with a fresh streaming view; every delta only calls `args.append(delta)`. At the `animation-frame` publication point, `buildViewNode()` refreshes observed answers and replaces the root only when they change; otherwise it reuses the currently published root. The Context and its published Node own these identities without a separate preparation cache. A stream whose arguments precede the name is not scanned: a view opened late sees a non-object prefix, turns invalid, and reports no fields.

Every stage's block exposes `name` and `args`; legacy `argsRaw` and result `call: { name, argsRaw } | null` remain available. `block-end` and `tool/call` reconcile argument fragments against their authoritative full text with length and exact per-fragment comparisons. Matching text seals the same reader and preserves its indexed fields; missing or conflicting deltas create a new `fromText()` view. No cumulative string or probabilistic hash is needed. PTC readers use `fromObject(payload)`, results reuse the started reader, and an unpaired result uses the shared empty view. Card models continue to read finalized `argsRaw`.

Assistant blocks retain tool identity and first-token timing, not argument deltas. Complete argument text comes from `block-end` or the durable message. Parameter-only deltas preserve Assistant State, while the Tool Definition owns preparing reads and notifications.

The Assembler shares one immutable Match per input and lifecycle role, including its Location, while each Definition retains independent State. Empty dependency sets require no replay work.

Rows use the same readers across stages: read/write/edit show an openable path once `file_path` closes; write/edit show decoded content length in 1024-character units while content streams; bash/pwsh/run_code show the description prefix. Chat group detail reads the same view using its existing field priority. Without usable detail it stays empty while fields can still arrive, then falls back to the tool name once `closed()` is true, for every category.

Group detail normalizes an initial 512-unit decoded prefix and expands it only when whitespace or multi-unit grapheme clusters prevent deciding the 160-cluster result. A filled prefix remains unchanged as its field grows, while a later higher-priority field still republishes the detail. String-length checks do not materialize the full text. Detail already within 160 UTF-16 units requires no grapheme traversal.

Third-party tools receive the same view without registration or a separate subscription. Write/edit and Bash share their component across stages. The mutable argument reader is a narrow exception to JSON-compatible owner data: its Definition publishes a new block reference when an observed answer changes. Scan caches use private fields so read history does not affect structural comparison of equal sources.

### Argument declaration order

`tool-bash` and `tool-pwsh` declare `description` before `command` and include the ordering instruction. Both `parameters` declarations of `run_code` put `description` before `code` and share a parameter description requesting that generation order for TypeScript and Python. Write/edit declare `file_path` first and ask for it before `content` or `old_string`/`new_string` in the path parameter description. Read retains its leading `file_path`; other tools retain their argument order.

## Alternatives considered

**Parse inside a hook closure (a selector subscribing to the Step source).** Only the subscribing row sees the parsed result, so group titles need another subscription and each row owns parser lifetime. Definition-owned views share parsed fields across consumers.

**Keeping a per-tool field specification in the Definition (built-in table plus a runtime registry).** The Definition is a pure function without ctx, so a runtime registry could only reach it through a factory closure, and a third-party tool would register in two places, the slot and the registry; the specification only ever said which fields keep text, information that on-demand decoding from the raw text no longer needs.

**Third-party `partial-json`.** It reparses the cumulative input each frame and does not expose string completion separately from the decoded value.

**Eagerly parse every field.** Large fields such as `content` usually need only a length; eagerly materializing their text adds decoding and memory costs before a consumer asks for it. Observing the entire key list also republishes a block when an unused argument appears; detail keeps field-specific observations.

**Slice the normalized field for a truncated detail.** A V8 substring can retain the entire field. Joining the bounded selection of grapheme clusters keeps the displayed prefix independent of that source.

**Reorder `properties` only.** Measured 0/40 effective; the model follows the `required` order.

## Verification

- Parser tests cover lazy scanning, observed-answer changes, empty and repeated keys, split escapes, non-string values, invalid input, sealed views, and read-independent structural equality.
- Row and grouping tests cover streamed paths and descriptions, content length, shared row identity, name fallback only when arguments cannot grow, and at most 161 clusters per truncation pass without changing whitespace or Unicode handling.
- Negative controls restore read-time acknowledgement, repeated Match allocation, and short-text segmentation; four focused tests fail at their corresponding assertions and pass after restoration. Definitions retain independent State; Turn and Step records remain Session-owned.
- Additional controls eagerly parse unread containers, accept same-length conflicting text, or rebuild Assistant State for parameter-only deltas. Each fails its owning assertion; the boundary-index implementation passes after restoration.

The required [conversation-fold benchmark](../../../../benchmarks/conversation-fold/conversation-fold.bench.client.ts) drives the real Tool Definition, Assembler, Chat groups, and published write-row reads with 16-character fragments, flushing every 64 fragments. Three fresh compiled Node workers report all samples and their median; setup and forced GC are outside timing, and retained heap is measured with the Assembler and argument view still reachable. Row reads validate decoded progress and the file path; the worker also reports process peak RSS.

Local Chat-only measurements on 2026-09-29 compare the pre-feature baseline with the optimized implementation for 512 KiB write content and 32,769 body deltas. On Linux x64, AMD EPYC 7763, Node 24.18.0, median unprofiled processing time is 212.16 → 176.12 ms, cumulative allocation including collected objects is 132.06 → 76.65 MiB, and retained heap is 24.89 → 21.84 MiB. These measurements exclude model, network, browser rendering, and non-Chat targets; they do not establish whole-page or CI-runner latency.

Match calls remain 393,228; update calls rise from 98,307 to 131,076 because the Tool Definition consumes every argument delta. The baseline displays raw-length write progress rather than decoded argument reads.

The CI budgets remain 750/375 ms and 37.5/10 MiB: reference expectations of 300/150 ms use the shared 2× time scale and 1.25× headroom, while 30/8 MiB heap expectations use headroom only. Historical cumulative-indexing/full-segmentation controls take 3984.9–4035.5 ms for write and 1471.2–1494.9 ms for bash, exceeding those unchanged budgets.

## Consequences

- Observed argument changes replace preparing blocks; unread calls retain their block reference. Views retain source text, and group headers can request fields independently of tool rows. Started and settled views scan on first read without publishing updates.
- Schema order and description instructions encourage label-first generation but do not guarantee it. Rows show usable fields as they arrive; a late path delays its display and the accompanying content progress.
- Presentation remains Client-derived; argument scanning adds no Session event or persistence format.
- A stream whose name arrives after its arguments gives up scanning; that call's preparing row falls back to the title alone.
