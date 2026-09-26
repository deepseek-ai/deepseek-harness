---
description: "Tool-result retention with a shared text/image token budget and readable recovery files."
kind: "package-reference"
---

# @deepseek-ai/dsh-spill-policy

English | [中文](README.zh.md)

## Summary

Keep oversized text and image results within a shared estimated token budget. The model receives ordered head/tail content and a path to the complete result. Images remain in attachment storage; the result file records their readable paths. Omitting `maxInlineTokens` disables retention, and recovery failures leave the original content visible.

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

Mount the policy alongside a spill backend. Text and images share the configured budget after post-execute policy accepts the result.

### Minimal configuration

Load a spill backend and set `maxInlineTokens` in estimated tokens:

```yaml
- name: '@deepseek-ai/dsh-spill-local'
- name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineTokens: 12500
```

| Field | Default | Meaning |
|---|---|---|
| `maxInlineTokens` | omitted | Estimated token cap for retained text, images, image descriptions, and notices; omission disables retention |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-spill-policy) is the exhaustive source for every accepted field. A negative or fractional cap fails plugin load rather than corrupting per-call behavior.

### What the model sees

Oversized results keep their original order. Each end receives half the budget remaining after omission notices; text may be split, while each image is retained or omitted whole. Images inside the omitted interval are omitted too. A successful replacement stays within the configured token estimate:

```text
<retained head/tail preview>

(Omitted N bytes. Full formatted result stored at: /…/session-…/…-web_fetch.txt. Use read with offset/limit, or grep this path to search within it.)
```

The notice also reports omitted image counts. A notice-only result is allowed when no preview fits; if the notice itself exceeds the cap, the original content stays visible. The full result file keeps all accepted text and an attachment path at each image position, so the model can use `read` and then `read_image`. Attachment bytes are not copied into this file. Local attachment objects persist independently of spill cleanup.

### Which results are affected

The policy accepts text/image sequences. Results within budget, `read`, blocked decisions, value replacements, and other block types pass through. Text-only nested results are bounded only in their log copies. Provider or tool limits applied before this policy cannot be recovered here.

### Best-effort failure behavior

A missing owner or spill backend, failed storage, missing route image pricing, or unavailable execution-world image path logs a warning and keeps the original content. The policy never substitutes an unreadable path for an image.

### The durable log copy

PTC programs receive complete canonical values. Image-bearing sub-results are bounded before forwarding to the model; when every image is omitted, the model still receives the retained text and recovery notice. The dispatch log uses the same retained content. Text-only sub-call logs, including `read`, are bounded asynchronously without delaying program values.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the policy; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The pure retention function selects ordered content by cost; the plugin owns policy, recovery text, and storage calls. Text uses the existing token-meter estimate. Images use the active route's `imageRequestPricing`, including descriptor text. DeepSeek routes reuse the provider's image-dimension calculator. The budget is an estimate, not an exact tokenizer guarantee.

### The two arms

The prepended `tools/post-execute` listener delegates before bounding accepted content. `tools/ptc-dispatch-log` shares the same helper. MCP's `projectContent` installs real image blocks before these policies; later content replacement, value replacement, or blocking remains authoritative.

<a id="shared-notice-ownership"></a>
### Shared notice ownership

The browser-safe `./notice` entry owns `formatSpillNotice(omitted, ref, images)` and `hasSpillNotice(text)`. It recognizes both historical byte-only notices and notices with whole-image counts without changing recorded text.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` validation, the two waterfall listeners, the shared replacement helper |
| [`src/notice.ts`](src/notice.ts) | Browser-safe notice formatting and recognition, published as `./notice` |
| [`src/retention.ts`](src/retention.ts) | Pure ordered text/image head-tail retention |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Failure modes

Recovery or pricing failures preserve the input and log the reason. Negative, fractional, or unsafe-integer budgets fail at plugin load. Results containing unsupported block types remain unchanged.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Spill storage service](../spill/README.md) — the `saveText` contract behind the policy's replacement.
- [dsh-spill-local](../spill-local/README.md) — the local backend that stores the spilled text.
- [Token meter](../../llm/token-meter/README.md) — shared text estimates and route image accounting.
- [Tool output spill decision](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) — the capability boundary and design rationale.

-----

<a id="model-experience"></a>
## Model Experience

### Oversized text and image results

#### What the model sees

The retained prefix and suffix keep image order, with `[...]` at the omitted interval. The final notice names omitted text bytes, optional whole-image counts, and the complete-result path. Reading that file reveals the omitted text and image addresses.

#### Token effect

A successful replacement fits `maxInlineTokens` under the shared text estimate and active route's image calculator, including notices and image descriptor text. Provider-reported usage remains authoritative.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the policy cannot help. They are current package constraints.

- **Text recognition cannot authenticate output** — a tool can print the same notice text; `hasSpillNotice` identifies a text convention, not proof that the policy saved a result.
- **Unavailable recovery or pricing** — images require a route calculator and execution-readable attachment paths; otherwise the original content stays visible. Unsupported blocks, blocked feedback, and `read` also pass through.
- **A notice that cannot fit disables replacement for that call** — a tiny cap or long locator leaves the oversized original inline after the backend has already saved an unreferenced spill.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions. It is explicitly non-authoritative.

#### Future: per-tool configuration

Per-tool opt-out or per-tool policy declarations remain deferred; the built-in `read` skip covers the known loop, and a second real tool need would justify configuration.

#### Future: earlier spill

The policy only sees final accepted content. Earlier provider truncation and tool-owned output limits remain outside its scope.

</details>
