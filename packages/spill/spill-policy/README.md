---
description: "The tool-result spill policy: how deployments keep oversized plain-text tool results out of the model's context with a preview and a retrievable spill file."
kind: "package-reference"
---

# @deepseek-ai/dsh-spill-policy

English | [中文](README.zh.md)

## Summary

`dsh-spill-policy` keeps oversized plain-text tool results out of the model's context: when a final result exceeds `maxInlineBytes`, it saves the full text through `ctx.spillStore` and replaces the model-facing result with a bounded head/tail preview plus the backend's locator and retrieval guidance, which the model can use to read or grep the spill file. It registers no service and owns no storage or preview mechanics — storage is the mounted `SpillStore` backend and previews come from `dsh-output-retention`; it only decides when to spill and composes the notice. It is opt-in and best-effort: omitted `maxInlineBytes` disables it entirely, and a spill failure leaves the original result visible. A second arm applies the same cap to the durable log copy of `run_code` sub-call results, so replay and UIs never grow unbounded either.

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

Mount the policy alongside a spill backend to cap how much of a tool's plain-text result the model sees. The cap applies to final results after the tool has run; results the policy leaves alone still pass through unchanged.

### Minimal configuration

Load the policy with a `maxInlineBytes` budget, in UTF-8 bytes, and a spill backend:

```yaml
- name: '@deepseek-ai/dsh-spill-local'
- name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
```

| Field | Default | Meaning |
|---|---|---|
| `maxInlineBytes` | omitted | Model-facing context cap for a plain-text result, in UTF-8 bytes; omitted disables the policy entirely |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-spill-policy) is the exhaustive source for every accepted field. A negative or fractional cap fails plugin load rather than corrupting per-call behavior.

### What the model sees

An oversized plain-text result is replaced by a preview plus a notice inside the same budget, so the whole replacement never exceeds `maxInlineBytes`:

```text
<retained head/tail preview>

(Omitted N bytes. Full formatted result stored at: /…/session-…/…-web_fetch.txt. Use read with offset/limit, or grep this path to search within it.)
```

When the notice alone fills the budget (a tiny cap or a long locator), the preview is empty and only the notice is returned; if even that would exceed the cap, the policy keeps the original inline result — a within-cap replacement is always smaller than the original. The full text stays available in the spill file, and a successful replacement changes only the model-facing copy, never the canonical programmatic result.

### Which results are affected

The policy shapes only final, accepted, plain-text results. Results at or below the cap, results containing any non-text block, nested composite calls, `read` results, blocked decisions, and accepted value replacements all pass through unchanged. Provider-level truncation that already happened (for example `web-fetch-http.maxBodyChars`) cannot be recovered here — the spill file holds what the tool actually returned.

### Best-effort failure behavior

A missing session owner, a missing `ctx.spillStore` backend, or a `saveText` rejection logs a warning and returns the original result. A spill failure never turns a successful call into an error and never hides the inline result.

### The durable log copy

The same cap also bounds the session-log copy of each `run_code` sub-call result: the program still receives the complete value, only the log's copy is replaced with the preview and locator. Oversized `read` sub-call results are bounded here too, since a log copy is not model context.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the policy; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The policy is deliberately narrow: it only decides **when** to spill and composes the notice. It registers no service, owns no storage, and owns no preview mechanics — `TextRetainer` from `dsh-output-retention` builds the head/tail preview. Two invariants shape the code: the model-facing replacement never exceeds `maxInlineBytes` (the notice's byte cost is reserved out of the budget first), and a spill failure never changes the tool call's outcome.

### The two arms

A `tools/post-execute` waterfall listener (registered with `prepend`, delegating via `next()`) bounds the model-facing result; a `tools/ptc-dispatch-log` listener bounds the durable log copy of each `run_code` sub-call. Both share one replacement helper so the two projections are byte-identical. The post-execute arm skips `read` to avoid a read → spill → read loop; the dispatch-log arm bounds `read` sub-calls because a log copy is not model context.

<a id="shared-notice-ownership"></a>
### Shared notice ownership

The browser-safe `@deepseek-ai/dsh-spill-policy/notice` entry owns both `formatSpillNotice(omitted, ref)`, used by the producer, and `hasSpillNotice(text)`, used by presentation consumers. Formatting and recognition share the notice delimiters; omission validation uses the existing `describeOmitted` formatter rather than a second copy of its prose. Recognition accepts a complete final notice after a preview or by itself and preserves the persisted notice spelling. It reads recorded text without rewriting it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` validation, the two waterfall listeners, the shared replacement helper |
| [`src/notice.ts`](src/notice.ts) | Browser-safe notice formatting and recognition, published as `./notice` |
| [`src/types.ts`](src/types.ts) | `SpillPolicyExec`: the minimal structural view of a tool execution the policy reads for the owning session id |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Failure modes

Best-effort degradation applies to both arms: no session owner, no backend, a save rejection, or no within-cap replacement logs a warning and keeps the original content. Load-time validation rejects a negative or fractional `maxInlineBytes` so a bad config fails the deployment, not every oversized call.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Spill storage service](../spill/README.md) — the `saveText` contract behind the policy's replacement.
- [dsh-spill-local](../spill-local/README.md) — the local backend that stores the spilled text.
- [dsh-output-retention](../../util/output-retention/README.md) — the preview mechanics (`TextRetainer`) the policy composes.
- [Tool output spill decision](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) — the capability boundary and design rationale.

-----

<a id="model-experience"></a>
## Model Experience

### Oversized plain-text result

#### What the model sees

Results at or below `maxInlineBytes`, nested results, `read` results, blocked decisions, and results containing non-text blocks are unchanged. An oversized plain-text model-facing result becomes a bounded head/tail preview followed by `(Omitted <bytes> bytes. Full formatted result stored at: <locator>. <retrievalHint>)`; a storage or ownership failure leaves the original result visible.

#### Token effect

A successful replacement is at most `maxInlineBytes` UTF-8 bytes and remains in history until compaction; the full spill text is not resent to the model.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the policy cannot help. They are current package constraints.

- **Text recognition cannot authenticate output** — a tool can print the same notice text; `hasSpillNotice` identifies a text convention, not proof that the policy saved a result.
- **Only final plain-text results are spillable** — mixed-content results, blocked feedback, and `read` pass through; provider truncation or tool-owned retention that happened earlier cannot be recovered here.
- **A notice that cannot fit disables replacement for that call** — a tiny cap or long locator leaves the oversized original inline after the backend has already saved an unreferenced spill.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions. It is explicitly non-authoritative.

#### Future: per-tool configuration

Per-tool opt-out or per-tool policy declarations remain deferred; the built-in `read` skip covers the known loop, and a second real tool need would justify configuration.

#### Future: earlier spill

The policy only sees final formatted text, so content already capped by a provider or held only as runtime artifacts (for example bash streams or subagent rollouts) stays out of reach; tool-owned early spill through `ctx.spillStore` is deferred.

</details>
