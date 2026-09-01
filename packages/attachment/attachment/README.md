---
description: "Durable image attachments for users and maintainers attaching, reusing, or debugging images in prompts and commands."
kind: "package-reference"
---

# @deepseek-ai/dsh-attachment

English | [中文](README.zh.md)

## Summary

You can attach images to prompts and commands, and the harness keeps provider-independent normalized versions durably: each source image is admitted and normalized before your message is processed, reappears in conversation history, and is projected to the selected model route in later turns of the same session. The shipped `dsh` composition enables this with no setup. Attached images survive restarts, while browser paths, provider URLs, local storage paths, and base64 never enter durable session events. Only raster formats (PNG, JPEG, WebP, GIF) are accepted, and unsent composer drafts stay in the browser until you submit. Stored images are never deleted automatically, and non-image files, audio, and video are not supported yet.

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

Image attachments work end to end: attach an image to a prompt or a command, and it is saved, shown in history, and sent to the model without any further action from you. In the default `dsh` composition everything is already wired; when you compose your own setup, one plugin enables the capability.

### Attach images to a prompt

Attach one or more images to a user prompt in the client UI. Each source is checked, normalized to a provider-independent 8-bit sRGB/sRGBA raster, and saved before your message is processed; if any image is refused, the whole message fails and nothing is published. Supported source formats are PNG, JPEG, WebP, and GIF; a deployment controls source limits separately from normalized-storage and route-specific request limits. The one plugin below enables durable image attachments (the shipped base composition already mounts it):

```yaml
- name: '@deepseek-ai/dsh-attachment-local'
```

### Pass images to commands

Commands that accept image input receive attached images the same way. If a command does not accept images, the harness refuses with an error message instead of silently dropping them.

### Reuse images across the session

Saved normalized images stay in conversation history and are projected into deterministic, route-sized request versions in later turns; after a restart, a resumed session shows and reuses the same images. When the current execution filesystem maps the stored host object, the request descriptor also carries a read-only process path that the model can inspect. When history or a request version is read back, the stored bytes are checked against what was recorded, so a missing, corrupted, or swapped image surfaces as an error rather than wrong bytes.

### What can go wrong

An image can be refused when you attach it — unsupported format, over the size, pixel, or dimension limits, or bytes that do not match their declared type — and the message then fails as a whole. Later, a history read can fail if the stored image was deleted or corrupted on disk. Failures carry stable codes so the client and protocol adapters can explain them in their own words.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the seam and the service operations that realize the user-visible behavior; observable behavior is fully covered in [Use this package](#use-this-package).

### Design decisions

- **Normalize and persist before event.** Every source is prepared and verified before the batch publishes in order, so the session log never references a partial or failed normalization.
- **Immutable and retention-neutral.** Objects are immutable once published; resumed and forked sessions may share them, so reference-aware garbage collection is deferred rather than tied to any one session's deletion.
- **Verify on read.** Reads check bytes and metadata against the logged reference before returning them, and request projections fully decode cached bytes, so a missing, corrupted, or swapped object fails closed.
- **Role-neutral image blocks.** The `ImageBlock` content block in `dsh-llm` carries an `ImageAttachmentRef`; provider adapters resolve it into deterministic request versions with explicit pixel and byte budgets, while execution filesystems may map the immutable host object to a model-readable process path.
- **Error routing by code.** `AttachmentError` re-implements the `HarnessError` shape instead of extending it because the base lives in `dsh-llm`, which depends on this package; consumers route on `code`, never on the prototype chain.

### Service operations

The service family runs one admission-and-storage flow: every entry point enforces source batch limits and canonical base64, prepares provider-independent normalized attachments before publishing any member, and commits them durably in input order without partial results. `readImageRequest` derives deterministic route-sized variants whose identity includes the attachment id, transform version, pixel and byte budgets, and encoder settings. The pure `requestImageDimensions` export computes each projection's aspect-preserving dimensions from a total-pixel budget, so providers and request pricing share one geometry. `imageHostPath` exposes an implementation-owned host location only to trusted same-process consumers that need execution-world mapping. Callers compose ordered batches while the implementation owns compression concurrency, caching, and singleflight. Reads and projections preserve caller cancellation. Failures carry stable machine-readable codes, and the caller-correctable admission subset is recognizable at runtime so each protocol adapter maps its own vocabulary; the exact per-operation contracts live in [`src/index.ts`](src/index.ts) and [`src/error.ts`](src/error.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: abstract `AttachmentStore` service and re-exports |
| [`src/types.ts`](src/types.ts) | Durable vocabulary: references, limits, upload and store payloads |
| [`src/admission.ts`](src/admission.ts) | Browser prompt admission: canonical-base64 enforcement, `saveImages` delegation, and durable prompt-part projection |
| [`src/error.ts`](src/error.ts) | `AttachmentError` class and the `isImageAdmissionError` runtime subset |
| [`src/brand.ts`](src/brand.ts) | `AttachmentId` branded opaque identifier |
| — | No runtime invariant companion is published; this stateless seam owns types while implementations enforce immutable-store checks. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

For the full service contract and payload types, read the subsystem reference; for the storage that backs this capability, read the local backend.

- [Attachment subsystem reference](../../../docs/subsystems/attachment.md) — service contract, payload types, and the `ctx.attachments` cordis surface.
- [Local filesystem backend](../attachment-local/README.md) — where your attached images are stored on this machine.
- [Capability seams](../../../docs/capability-seams.md) — how this capability family is split into roles.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the provider adapter, which resolves each durable reference into an exact request version and sends its stable attachment id and actual dimensions beside the image. When the execution filesystem maps the stored object, the descriptor also includes a read-only process path and a matching extension for a writable copy.

#### KV Cache effect

Adding an image changes the provider request and therefore invalidates the affected request suffix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what image attachments can and cannot do; they are current package constraints, not a task backlog.

- **Raster images only** — PNG, JPEG, WebP, and GIF are accepted; generic files, audio, and video are not supported yet.
- **Images are never deleted** — stored images are retained indefinitely; nothing removes them automatically.
- **Unsent drafts are not saved** — a composer draft stays in the browser until you submit the message.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and the package code.

#### Future: reference-aware garbage collection

Resumed and forked sessions may share immutable objects, so any retention policy needs a reference model that accounts for session lineage before objects can be collected. No decision is recorded yet; the local backend currently retains everything.

#### Future: non-image attachments and assistant-side output

Generic files, audio, and video would need separate lifecycle and provider contracts, and the role-neutral `ImageBlock` leaves assistant-side image output as forward compatibility — current production adapters declare text-only output, so only user content carries images. Both directions are undecided.

</details>
