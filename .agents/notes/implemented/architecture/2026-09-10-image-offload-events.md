# Agent Note: Durable image offload events

Status: implemented

English | [中文](2026-09-10-image-offload-events.zh.md)

## Problem

A request can exceed an image-capable route's byte or image-count budget. Recomputing the omitted prefix for each request lets a route switch, inline fallback, or compaction restore previously omitted images. The model-visible image set then depends on unlogged request preparation. The [unified image pipeline](../feature/2026-08-20-unified-image-request-pipeline.md) owns attachment normalization and request versions; durable omission needs its own recorded decision.

## Decision

`dsh-compaction-image-offload` owns recovery on the `agent/request-error` waterfall. An `IMAGE_OFFLOAD_REQUIRED` failure supplies `offloadImages`; the plugin selects that many oldest retained input-image occurrences in current surface order, appends one `image/offload` event, and returns `retry`. Assistant output images are excluded. If no retained input image remains, the plugin delegates. Other failures do not enter this recovery. Offload does not consume the provider retry budget or emit `llm/retry`.

Summary requests bypass the agent error waterfall. `dsh-compaction-basic` preserves the full `LlmFailure`, checks cancellation and selection stability, and dispatches synchronous `compaction/summary-error` with the selected event seqs. The same image-offload plugin records omissions only within that selection. Synchronous recovery keeps the stability check and decision adjacent. The backend then re-derives input and pricing, including the shrink baseline. Each retry requires additional omitted occurrences; exhaustion delegates the failure. A later summary failure or cancellation preserves any recorded omissions, so command errors do not claim the conversation is unchanged.

The event payload is `{ targets: [{ seq, imageIndexes }] }`. Each target identifies a current `user/message` or `tool/result` node. Its strictly increasing, zero-based indexes enumerate every image in depth-first content order, including tool-role result content and previously omitted images. Equal attachment ids remain distinct occurrences. Exact selections remain unambiguous after positional replacements reorder the surface; an attachment id or a raw-log prefix cannot identify the selected set.

The event has no `surfaceOp`. It neither creates a message nor replaces a message node. The plugin's pure projection validates all targets before Session commits the event and rejects missing or shadowed nodes, output images, duplicate targets, invalid indexes, and already omitted occurrences. Reconstruction derives immutable message copies with `ImageBlock.offloaded: true` at the recorded positions. Original events, message ids, sources, and unaffected blocks remain unchanged. Resume, fork, and replay apply the same selections from the log.

The compaction plugin owns selection, event declaration, image validation and projection, and retry policy. [Plugin-owned message projections](2026-09-11-plugin-owned-message-projections.md) owns the generic Session integration and explicit detached assembly, superseding core-owned interpretation. The instance `deriveEventMessage()` and `deriveMessages()` return projected messages; pure reconstructors pass `foldSurface(events, projections).projectedMessages` to the exported `deriveEventMessage()`. Rewriters preserving images must consume projected messages, including tool-result pruning and summarizer input.

`contentGeneration` advances for message replacements and image-offload events so cached history and request series are refreshed. `replaceGeneration` advances only for replacements; image omission cannot masquerade as successful text compaction. An unchanged request envelope gets a `request/header` with reason `series`; a simultaneous envelope change carries `startsSeries: true`.

Adapters prepare only retained images and render marked occurrences as `offloadedImageText` with the current execution-world access path. Route-local budget checks report required counts, including the tighter inline fallback budget, but do not edit history. These checks are provisional: a provider failure that identifies uncacheable images can replace local counting without moving the durable decision into the adapter.

Token accounting applies selections to the affected nodes' image occurrences without replacing their identities or changing prior usage-anchor snapshots. Route pricing substitutes placeholder text for image cost. The fixed structural heuristic excludes the `offloaded` marker, so image omission does not change that heuristic or require a `compaction/prune` shadow price. The context-pressure and context-breakdown checkpoint versions advance to reject cached estimates that counted the marker.

`image/offload` is required on read. Its addition changes the recognized event vocabulary, not the Session envelope or operation grammar, so it does not advance `SESSION_FORMAT_VERSION`. A reader without this event type refuses the log instead of silently restoring omitted images.

## Alternatives considered

**Reuse `compaction/prune` and `surfaceOp: replace`.** The [archived replacement design](../../archived/architecture/2026-09-02-durable-image-offload.md) records full carrying-message copies and couples omission to node replacement and shadow-price accounting. A dedicated event expresses which images are omitted while retaining message identity and keeping retry policy in the same plugin.

**Record a request-local projection outcome.** A record that does not affect subsequent derivation cannot prevent omitted images from returning. Logging whole request bodies repeats message history for a decision that needs only occurrence indexes.

**Use an attachment id or a single watermark.** Attachments can occur repeatedly, and surface order can differ from event-sequence order. Explicit per-node indexes distinguish these cases without redefining a watermark after every replacement.

**Move selection into the loop or adapters.** The request-error extension already owns repair and retry. The adapter knows the route budget; the plugin knows the session input order. Neither requires route-specific policy in the shared loop.

## Consequences

Omission remains effective when a route budget grows, an inline fallback ends, or compaction reduces context. It does not delete attachment bytes. Reading the placeholder's access path creates a new image occurrence that can be retained independently. The execution-world path is still resolved during serialization, as it is for retained image handles; this event records the selected image set, not filesystem mappings.

Session invokes the registered pure projection and maintains one content-generation signal. Consumers reconstructing model input must use projected messages. Human views can still show original images from immutable events. The plugin requires neither token-meter nor compaction services merely to record omission.

## Testing

Plugin projection tests cover nested and repeated occurrences, atomic rejection, cache invalidation, pure folding, restore, fork, and untouched source events. Recovery tests cover consecutive failures, current surface order, exhausted recovery, fresh request headers, and disposal. Token-meter tests preserve node identity and prior usage anchors while repricing only selected occurrences. Tool-result pruning and compaction tests ensure later rewrites consume the projected history. TypeScript and Python SDK expected outputs exercise the required event through shipped profiles.
