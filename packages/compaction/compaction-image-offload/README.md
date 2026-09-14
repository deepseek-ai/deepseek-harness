---
description: "The image offload executor for deployments composing compaction: what happens when an image-capable route rejects a request as over its image budget."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-image-offload

English | [中文](README.zh.md)

## Summary

Image-heavy conversations continue when older images exceed a model route's budget. The plugin permanently replaces those images with text naming each attachment and its available read-only path, then retries without spending the provider retry budget. Later requests retain that choice across route changes, resume, and replay. Token accounting follows the logged selections, and provider cache reuse ends at the first changed message.

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

Mount this plugin in every composition that runs the agent loop with an image-capable route. The shipped `dsh` base does. Without it, an `IMAGE_OFFLOAD_REQUIRED` failure reaches ordinary recovery and ends the turn as an error. The plugin has no configuration: the DeepSeek adapter enforces its file-mode and inline-fallback budgets, the pi-ai adapter its base64 bound, and each reports the count it needs offloaded.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-compaction-image-offload'
```

### What you can observe

Each decision appends one `image/offload` event identifying the selected occurrences by current message-event sequence and depth-first image index. The message events and surface node identities remain unchanged. An agent retry follows a fresh `request/header` identifying a new message series. Summary retries remain inside the same compaction bracket.

### Failures and recovery

The plugin acts only on `IMAGE_OFFLOAD_REQUIRED` failures that carry `offloadImages`. It walks the surface in model request order, skips assistant nodes and images already marked, and marks that many occurrences. When nothing remains to offload it delegates on the `agent/request-error` waterfall, so downstream recovery or the ordinary turn error applies. The retry spends no provider retry budget and logs no `llm/retry` event.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This package owns the event declaration, reference validation, immutable image projection, selection, and retry policy. It registers `imageOffloadProjection` with Session before accepting image-offload events. The same browser-safe definition is exported from `./projection` for detached replay; the installed format catalog assembles it for offline readers. Missing registration rejects live restore, and unloading a used definition blocks further message derivation. Token measurement folds the same selections without replacement shadow prices.

Summary failures use the synchronous `compaction/summary-error` waterfall. The plugin selects only the supplied summary region and returns true after recording an omission. The compaction backend re-derives and re-prices that region before retrying; each retry omits additional retained occurrences, so recovery ends when none remain. Cancellation and unrelated selection changes reject the summary. Recorded omissions survive later failure or cancellation.

No runtime invariant companion is published: the pure projection rejects invalid or repeated image references before Session commits the event, and this executor retains no separate mutable offload state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Dedicated image-offload events](../../../.agents/notes/implemented/architecture/2026-09-10-image-offload-events.md) — durable selections, ownership, and rejected alternatives.
- [compaction seam](../compaction/README.md) — the neighboring summary and text-pruning operations.
- [compaction-tool-result-pruner](../compaction-tool-result-pruner/README.md) — the sibling executor that trims tool outputs while preserving image selections.
- [dsh-llm](../../llm/llm/README.md) — `ImageBlock.offloaded`, `IMAGE_OFFLOAD_REQUIRED`, and the placeholder projection.
- [llm-deepseek adapter](../../llm/llm-deepseek/README.md) and [llm-pi-ai adapter](../../llm/llm-pi-ai/README.md) — the route budgets that report offload counts.

-----

<a id="model-experience"></a>
## Model Experience

### Offloaded request images

#### What the model sees

Every selected image occurrence reaches the model as placeholder text (`offloadedImageText`) naming the attachment and its available read-only path; unselected occurrences stay images. Selections persist across requests. A new tool read may introduce a new occurrence of the same attachment without restoring the old one.

#### Token effect

An offloaded occurrence costs its placeholder text instead of visual tokens. The token meter applies the logged selections when pricing each node. Reference-only heuristic counts exclude offload metadata.

#### KV Cache effect

A selection turns earlier images into placeholder text, so provider cache reuse ends at the first changed image for that request. The selected occurrences remain omitted afterwards.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Offloaded images never return automatically** — a larger budget, a larger route, or compaction lowering the total leaves the marks in place; recovery is the read-only path in the placeholder.
- **Every offload costs one failed attempt** — nothing plans an offload before dispatch; the route's rejection is the signal, which matches the planned move to provider-reported uncacheable images.
- **A temporary small budget offloads permanently** — a Files outage that forces the inline fallback, or a temporary switch to a small-budget route, offloads images a later route would have sent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The route-local byte checks that produce `IMAGE_OFFLOAD_REQUIRED` are provisional: once the provider reports uncacheable images itself, the adapters map that report to a count and this executor stays as it is.

</details>
