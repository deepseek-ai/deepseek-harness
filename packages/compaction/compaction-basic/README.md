---
description: "Automatic conversation condensation for deployments choosing, tuning, or debugging how older history is summarized as token pressure builds."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-basic

English | [中文](README.zh.md)

## Summary

`dsh-compaction-basic` keeps long agent conversations working near the model's context limit. As token pressure builds, it automatically condenses the oldest part of the conversation into a summary and keeps the recent part intact; after a context-overflow error it condenses and retries. You can also condense on demand with `/compact` from `dsh-command-compact`, and mount `dsh-compaction-tool-result-pruner` to trim oversized tool outputs first. Condensation costs one extra model request that reads the selected history and writes the summary; only the summary text is kept. It condenses derived history only — it cannot shrink the system prompt, tools, or session prefix, and one indivisible unit such as a single huge tool call cannot be split.

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

Mount this package to get automatic conversation condensation in a composition that already provides an LLM, session storage, and token measurement. The shipped `dsh` base enables it by default; mount it explicitly to control when condensation starts.

### What you get

With the default settings you get four behaviors: automatic condensation as the conversation grows toward the model's context limit; recovery after a confirmed context-overflow error, where the conversation condenses and the request retries; on-demand condensation through the `/compact` command; and — when the pruner is mounted — trimming of oversized tool outputs before condensation.

### Smallest working composition

Mount session storage, token measurement, the optional pruner, this backend, and optionally the on-demand command:

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
- name: '@deepseek-ai/dsh-compaction-basic'
- name: '@deepseek-ai/dsh-command-compact'
```

You can verify success by watching the conversation continue past the point where it would otherwise overflow, and by running `/compact` for an immediate condensation. If the composition lacks an LLM, session storage, or token measurement, the plugin fails to load. One backend can serve models with different context sizes; give each route its own threshold and retention with a per-model override:

```yaml
- name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    modelPolicies:
      - provider: local
        model: small-context
        thresholdRatio: 0.7
        retainTokens: 2048
```

### Tuning when condensation starts

All settings are optional. The defaults start condensing at 80% of the routed model's context window and keep the newest 16% verbatim; the table below is the complete policy surface, and the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compaction-basic) is the exhaustive source.

| Field | Default | Meaning |
|---|---|---|
| `thresholdRatio` | `0.8` | Start condensing at `floor(routedContextWindow × ratio)`. |
| `retainRatio` | `0.16` | Recent conversation kept verbatim as a fraction of the routed context window; mutually exclusive with `retainTokens`. |
| `retainTokens` | — | Absolute recent-conversation budget kept verbatim; mutually exclusive with `retainRatio` and must be below the resolved threshold. |
| `summarizationProvider` | `''` | Set together with `summarizationModel`; an empty pair uses the latest routed request target, then the `AgentOptions` pair. |
| `summarizationModel` | `''` | Set together with `summarizationProvider`; an empty pair uses the latest routed request target, then the `AgentOptions` pair. |
| `maxTokens` | `8192` | Output cap for the summarization request; may include reasoning tokens. |
| `compactionRetries` | `1` | Extra condensation attempts after the first when pressure remains above threshold. |
| `maxOverflowRetries` | `1` | Maximum retries after a confirmed context-window overflow; `0` disables recovery only. |
| `modelPolicies` | `[]` | Exact `{ provider, model, ...partialPolicy }` overrides for individual model routes. |
| `auto` | `true` | Enable automatic condensation and overflow recovery; set `false` for manual-only operation. |

Misconfiguration fails fast: an unknown setting, a duplicate per-model override, both retention forms together, or a ratio retention that is not below the threshold all reject the plugin at load. An absolute `retainTokens` budget — top-level or per-model — that is not below its threshold fails when that model is first used, because the comparison needs the model's context size.

### What happens when condensation runs

The oldest balanced span is replaced by one summary message and the recent tail stays verbatim; the conversation continues from the summary. The operation reports how many history items were condensed and the estimated tokens freed. If nothing can be condensed safely — for example the whole conversation is one indivisible unit — nothing changes and nothing is written to the session log. If no model is available to write the summary (no configured target and no routed request yet), condensation fails with a clear error telling you to configure the summarization provider and model or route one request.

### On-demand condensation with /compact

With `dsh-command-compact` mounted, type `/compact` in a chat UI to condense immediately, even below the pressure threshold. The command reports how many history items were condensed and the estimated tokens saved. While the agent is mid-turn or condensation is already running, `/compact` reports that condensation is unavailable; prompts you send while it runs are accepted and start after it finishes.

### Trimming oversized tool outputs

Mount `dsh-compaction-tool-result-pruner` before this package to trim oversized tool results as part of condensation. Trimming makes no model call and can remove the need to summarize at all: when the trimmed conversation fits within the threshold, condensation skips the summary. Trimming only runs after a condensation trigger qualifies — a below-pressure conversation is never touched.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the backend; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The backend is built on four commitments:

- **One measurement service prices every decision.** The singleton `ctx.tokenMeter` measures the latest canonical logged envelope and current surface at one consumed-log revision. When the routed adapter declares request-image pricing, the meter applies it to image history. Pressure, recent-tail retention, range selection, and shrink validation use the same route-priced node figures; logged replacement shadow prices stay on the route-independent heuristic so pure projection folds remain consistent.
- **The log-recorded bracket is the transaction.** All entry points share one bracket-first region transaction: validate the range and live lock, append `compaction/start` synchronously, prepare and await the summary, revalidate, append `compaction/summary` plus the replacement, and make exactly one closing attempt. Automatic and explicit-region calls require a numeric open-turn owner and whole-surface stability; `compactNow()` reserves idle admission, uses `turn: null`, accepts append-only context outside its selected span, flushes every closed attempt, and releases admission in `finally`.
- **Summarization reuses the provider's warm prefix.** Replaying the last routed request's system prompt, tools, and shadowed-region messages byte-for-byte makes the auxiliary call a genuine prefix of the conversation, so only the trailing instruction and the summary output are uncached.
- **`summarize()` is the sole subclass hook.** A template- or remote-summarizer subclass can override it while pressure, retention, cited source events, shrink validation, and shadowed-token accounting stay on the token meter.

### Automatic triggers and overflow recovery

With `auto: true`, a serial `agent/pre-step` listener checks pressure before request derivation: it prices the latest durable routed request envelope through `ctx.tokenMeter`, and when pressure crosses the routed model's threshold it prunes, then summarizes the oldest balanced span while keeping a priced recent tail. The `agent/request-error` listener reacts to a provider-confirmed `CONTEXT_WINDOW_EXCEEDED`: it bypasses the normal threshold and retention policy, attempts one maximal balanced head reduction, and authorizes a retry only after the surface replacement generation advances. Cancellation stays authoritative throughout.

Pressure policy resolves capacity from the adapter that owns the durable route. An adapter that returns no capacity for a valid dynamic route makes the manual pressure path throw a target-specific configuration error; the automatic listener warns once for that exact target and continues with full history.

### Summarization mechanics

A direct `ctx.llm.stream()` call uses the configured provider/model pair and cap, falling back to the latest logged request target and then the `AgentOptions` pair, without running the loop-only `agent/request` extension point. The call replays the conversation's own system prompt, tools, and shadowed-region messages verbatim — including image references, which the selected adapter must resolve or explicitly reject — and appends the compaction instruction as the final user message, so it reuses the provider's warm prefix cache instead of invalidating it. The call sets `GenerateOptions.purpose` to `compaction`; only returned text enters the checkpoint, excluding reasoning and tool calls. Image output fails with `UNSUPPORTED_CONTENT` rather than disappearing. The replacement user message frames the summary with `<compacted-summary>` tags; the raw summary remains on the `compaction/summary` event.

### The region transaction

The transaction validates the surface span and the durable lock, appends `compaction/start`, summarizes through the hook, revalidates stability (whole-surface for automatic calls, selected-span for manual calls), rejects a summary that does not shrink its source, appends `compaction/summary` plus the replacement `user/message`, and makes exactly one `compaction/end` attempt. A live unmatched start is the durable lock: an unmatched marker before a newer `session/end-seed` is stale evidence from a prior lifecycle and does not block; one after that boundary reports `busy`. A failed close deliberately leaves a blocking orphan. Cancellation remains authoritative after cleanup and durability.

### Config resolution

`resolveConfig` validates and detaches the defaults, `resolveTargetPolicy` merges an exact provider/model override over them, and `resolveCompactSpec` scales the merged policy into concrete token budgets using the adapter-owned context capacity. Model discovery (`listModels()`) is never consulted for policy; only the durable route's capacity matters.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `BasicCompactionEngine`, automatic listeners, entry-point dispatch |
| [`src/region.ts`](src/region.ts) | Retention selection and the shared bracket-first compaction transaction |
| [`src/summarizer.ts`](src/summarizer.ts) | Default `ctx.llm.stream()` summarization, checkpoint framing, safe-summary projection |
| [`src/config.ts`](src/config.ts) | Load-time validation and routed-model policy resolution |
| [`src/types.ts`](src/types.ts) | `BasicCompactionConfig` and resolved policy vocabulary |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the shared seam to the optional companions and the decision evidence.

- [Compaction seam](../compaction/README.md) — the condensation contract this backend implements.
- [Compaction subsystem reference](../../../docs/subsystems/compaction.md) — the condensation vocabulary, results, and service behavior.
- [Tool-result pruner](../compaction-tool-result-pruner/README.md) — the optional companion that trims oversized tool outputs first.
- [Human /compact command](../command-compact/README.md) — on-demand condensation without waiting for pressure.
- [Token meter](../../llm/token-meter/README.md) — the measurement service that decides when to condense.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compaction-basic) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Conversation history

#### What the model sees

After a successful step crosses the threshold, oversized tool results are first rewritten when the optional pruner is loaded. If summarization remains necessary, the next request receives the checkpoint preamble below, a blank line, `<compacted-summary>`, the data-dependent summary, and `</compacted-summary>`. Overflow recovery rebuilds the immediate retry from whatever replacement advanced the surface. A checkpoint replaces the selected older range and is followed by the retained recent units.

##### Conversation checkpoint preamble

```markdown
This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.
```

#### Token effect

Model-free pruning can avoid the auxiliary call entirely; otherwise it reduces that call's transcript before the summary replaces an older range. The replacement reduces future input history rather than appending a second copy. A summary remains until a later compaction replaces it, while an indivisible non-tool unit can still exceed the budget.

#### KV Cache effect

Replacing rather than append-only. Each checkpoint invalidates reuse from the first replaced history token; the unchanged request prefix before that range remains reusable.

### Auxiliary summarizer request

#### What the model sees

The summarization model receives the conversation replayed verbatim — the same system prompt, tool schemas, and messages the last routed request sent for the shadowed region — followed by one final user message: the compaction instruction below. The conversation model never sees this private request or its reasoning; only returned text is stored.

##### Compaction instruction (final user message)

```markdown
You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Jobs
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.
```

#### Token effect

This is a separate model call: the replayed conversation prefix plus the fixed instruction as input, with `maxTokens`-capped output. Convergence retries can pay this cost more than once.

#### KV Cache effect

The replayed system prompt, tools, and shadowed-region messages match the conversation's last routed request byte-for-byte, so the provider's warm prefix cache is reused up to the trailing instruction; only that instruction, and the summary output, is uncached. Routing the summarizer to a different provider/model, or compacting a non-head range, forgoes this reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when automatic condensation is a poor fit or needs special care; they are the current package constraints.

- **Meter accuracy follows the fixed heuristic** — missing reusable provider usage falls back to character count plus structural overhead rather than exact tokenization; image occurrences carry provider-exact visual tokens only on routes whose adapter declares request-image pricing.
- **Overflow classification is adapter-maintained** — provider wording can change; both DeepSeek adapters normalize recognized context-limit failures to `CONTEXT_WINDOW_EXCEEDED`.
- **Some indivisible-unit and envelope-only overflow remains outside surface compaction** — recovery cannot shrink system/tools/prefix, split an indivisible non-tool node, or repair a tool unit whose non-prunable remainder still exceeds the window. The optional pruner can shrink text-bearing tool-result bulk inside an otherwise indivisible pair.
- **`compactRegion` requires an open turn** — a manual call on a fully-closed session throws ("no open turn") rather than compacting.
- **Summarization failure preserves the latest durable surface** — before any replacement, the auto path logs a warning and proceeds with full over-budget history. If pruning already landed, a later summarization failure proceeds from that durable pruned surface. Summarization truncation at `maxTokens`, which hidden reasoning tokens can consume, follows the same rule.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Default ratios, undecided** — `thresholdRatio: 0.8` and `retainRatio: 0.16` are fixed defaults; per-model tuning via `modelPolicies` exists, but no corpus-backed guidance on ideal values is recorded.
- **Tokenizer-accurate measurement, deferred** — the token meter's four-characters-per-token heuristic underprices CJK text and JSON schemas; exact tokenization remains an open direction for the measurement service.
- **Overflow recovery beyond canonical errors, undecided** — recovery triggers on `CONTEXT_WINDOW_EXCEEDED` only; other provider-side context failures are not classified.

</details>
