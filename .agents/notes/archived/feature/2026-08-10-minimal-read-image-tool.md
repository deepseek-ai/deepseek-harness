# Agent Note: A minimal read_image tool over existing seams

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-minimal-read-image-tool.zh.md)

## Problem

The multimodal attachment work gave user uploads a complete durable path, but the model itself had no way to inspect an image on disk. `read` rejects binary content by contract, so an agent asked about a screenshot or rendered chart either failed or used a lossy workaround. A standalone attempt in PR #598 combined the tool with loop-level route scoping, per-route schema visibility, and new session-log concepts. Those features were not required to publish a logged image tool result.

## Decision

Both image-reading operations live in `dsh-tool-fs` and publish ordinary logged tool results over existing extension points.

- **`read_image` reads a filesystem path.** Extension selects the declared PNG/JPEG/WebP/GIF media type; the attachment store's magic-byte and pixel validation stays authoritative. Bytes travel `ctx.fs.stat` → bounded `ctx.fs.readBytes` → `ctx.attachments.saveImage` → `fs/observed`. The tool result contains metadata and an `ImageBlock`.
- **`FileSystem.readBytes(target, signal, maxBytes)`** is a new required provider primitive: the byte bound lives at the seam so no backend can buffer an unbounded file, with the stat-size short-circuit and a one-byte-past-cap stream guard against post-stat growth (`FS_TOO_LARGE`).
- **Registration is composition-conditional, execution is route-gated.** The tools register only under `ctx.inject(['attachments'], …)`. Before I/O, the strict gate resolves the calling route through `ctx.llm.resolveModelInfo` and requires `image` in `inputModalities`; unknown capability refuses. A text-only route can still consume prior durable images because the shared LLM runtime projects them to placeholders at request assembly.
- **PTC mode forwards the image out-of-band**: a nested dispatch returns the canonical value (execution-local, no image block) and defers a `user`-role context message carrying the envelope and image, so the picture still reaches the next request.
- **llm-replay models may declare `inputModalities`**, which lets keyless ACP snapshots cover the image-capable result and the text-only refusal.

## Alternatives considered

- **PR #598's route-scoped design** used a request-ready extension point, per-route schema visibility, reversible projection, and three durable concepts. Shared LLM request projection now handles text-only routes without putting tool registration or session formats into agent-loop.
- **`agent.inject()` instead of the image-bearing tool result** — routes the image around the tool result as a separate injected user message. Rejected: the image *is* the tool's result; splitting them adds a second logged message with no gain, and the tool-result path already works end to end.
- **Magic-byte sniffing instead of extension declaration** — sniffing duplicates detection the attachment store already owns (sharp-backed, authoritative). The extension is only a *declaration*; a mismatch fails closed with a rename remedy rather than being silently accepted, which also keeps the model's mental map (file name ↔ content) honest. This rejection covers extension-bearing paths; [extension-less image paths](../bug-fix/2026-08-28-read-image-extensionless-paths.md) narrows it — a path that declares nothing is identified from its file signature.
- **Registering unconditionally and failing on a missing store** — rejected; a deployment without an attachment store cannot ever satisfy the tool, so its schema would be a standing lie. The route gate, by contrast, is per-call state and correctly lives at the execution boundary.

## Consequences

- The tools refuse execution on a text-only route, while existing images in session history are represented by request-local placeholders.
- Repeated image results accumulate request cost until request projection or compaction removes them; content addressing deduplicates durable bytes.
- The tool-result card now renders the image itself through the browser's `tool.call.images` slot (see [the tool-card image results note](2026-08-20-tool-card-image-results.md)); a UI without the attachment presentation plugin shows the result's envelope text.
