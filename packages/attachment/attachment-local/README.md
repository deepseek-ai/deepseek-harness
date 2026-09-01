---
description: "Local storage for your attached images below DSH_HOME, for users and maintainers choosing or debugging where image attachments are kept."
kind: "package-reference"
---

# @deepseek-ai/dsh-attachment-local

English | [中文](README.zh.md)

## Summary

This package provides the local storage and image-processing backend for attachments: source images are validated, oriented, stripped of metadata and color profiles, normalized to 8-bit sRGB/sRGBA, and saved below `DSH_HOME`; route-specific request versions are derived and cached separately. It is what the shipped `dsh` composition uses, so durable image attachments work without configuration. Identical normalized images are stored only once, concurrent reads of one request variant share work, and stored images stay readable after later admission-limit changes. Storage is local to this machine — other hosts cannot read these images — and objects are never deleted automatically.

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

In the default composition, attach images to a prompt or command and they are stored on this machine automatically. If you compose your own setup, mounting this one plugin gives you durable image attachments.

### Minimal configuration

Mount the plugin with no required configuration. The defaults below define what you can attach; the generated configuration catalog is the exhaustive source for every field.

```yaml
- name: '@deepseek-ai/dsh-attachment-local'
```

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | resolved | Explicit harness home; omitted follows `$DSH_HOME`, then `~/.dsh` |
| `maxImageBytes` | `20 MiB` | Maximum encoded source bytes accepted for one image |
| `maxImagesPerMessage` | `20` | Maximum image count accepted in one submitted message |
| `maxMessageImageBytes` | `200 MiB` | Maximum aggregate encoded source bytes in one submitted message |
| `maxImagePixels` | `64,000,000` | Maximum source width multiplied by height |
| `maxImageDimension` | `8192` | Maximum source width or height |
| `normalizedImageMaxPixels` | `2048 × 2048` | Total-pixel budget of the stored normalized image |
| `normalizedImageMaxDimension` | `8192` | Maximum long edge after applying the total-pixel budget |
| `normalizedImageMaxBytes` | `4 MiB` | Encoded-byte target; the smallest quality-ladder output is kept when none fits |
| `imageCompressionConcurrency` | `2` | FIFO limit for concurrent normalization and request transforms |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-attachment-local) is the exhaustive source for every accepted field and its JSDoc.

### Where your images are stored and how long they last

Attached images are kept below `<DSH_HOME>/attachments/v1` on this machine. Stored images are never deleted automatically, identical images are stored only once, and a later tightening of the limits never makes already-saved images unreadable. If your images must be readable from another machine, this package is not the right fit.

### What happens when you attach an image

Attach an image and its source limits, media, dimensions, and pixels are checked before it is normalized and saved. EXIF orientation is applied, metadata and color profiles are removed, transparency is preserved, and the raster is reduced under a total-pixel budget plus a long-edge cap. Alpha images use WebP and opaque images use JPEG on the shared 85/75/60 quality ladder; the smallest output is retained when every candidate exceeds the byte target. An accepted image reappears in history and later turns, including after restart; the selected model route receives a cached request version and, when its filesystem maps the host object, a read-only execution-world path.

### What can go wrong

An image can be refused when you attach it: unsupported format, over the byte, pixel, or per-side dimension limits, or bytes that do not match their declared type. On a later read, an image that was deleted or corrupted on disk fails with a clear error. Each failure carries a stable code so the client and protocol adapters can explain it in their own words.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the durability and verification design behind the storage, and the write and read paths that realize it; observable behavior is fully covered in [Use this package](#use-this-package).

### Design decisions

- **Durability by fsync chain, not existence.** A synced file alone does not survive a crash when its directory entry never reached storage, so the write path syncs every ancestor entry to a process-proven boundary before a reference can reach a session checkpoint.
- **Normalize once, project per route.** Admission persists one provider-independent normalized attachment; request projection derives deterministic variants without rewriting durable history.
- **Lazy alpha-routed encoding.** Alpha images use WebP and opaque images use JPEG; quality candidates run in 85/75/60 order, and the smallest output is retained when none meets the encoded-byte target.
- **Limits are write-time policy.** Byte, total-pixel, and per-side dimension limits bind admission only, so tightening them later never makes admitted history unreadable.

### Write and read paths

Objects land at `<DSH_HOME>/attachments/v1/objects/<sha256-prefix>/<sha256>`; equal bytes deduplicate to one object and one `sha256:` id. Before the first write, the process syncs every ancestor directory of the home down to the filesystem root once, so a directory another process created but has not yet synced is never mistaken for a safe boundary. Writes then stage bytes in `v1/tmp`, sync the temporary file, publish with an atomic exclusive hard link, and sync the publication directories — on Windows, filesystem metadata journaling owns entry durability. Once the save resolves, the reported reference is durable.

Admission accepts up to 20 images and 200 MiB of source bytes per message; one source may use up to 20 MiB, 64 million pixels, and 8192 pixels per side. It applies orientation, removes metadata and color profiles, and normalizes under a 2048×2048 total-pixel budget, an 8192-pixel long edge, and a 4 MiB encoded-byte target. Extreme aspect ratios therefore retain their short-edge resolution. Clean single-frame 8-bit sRGB/sRGBA PNG, JPEG, or WebP input already within those limits passes through byte-identically; GIF, animation, metadata, orientation, 16-bit PNG, and incompatible color spaces force conversion.

Request versions live below `<DSH_HOME>/attachments/v1/request-images/`. `readImageRequest` scales without enlargement to a route pixel budget, then applies a separate encoded-byte target through the same alpha routing and quality ladder. Its cache identity includes the attachment id, transform version, budgets, and fixed encoder settings; cached bytes are header-probed for format, 8-bit sRGB/sRGBA, dimensions, and alpha facts, and a mismatch regenerates the entry. Concurrent callers share one transform and cache write, while cancellation stops shared work only when no waiter remains. `imageHostPath` derives the normalized object's host path, and the mounted filesystem may map that path into its execution world without writing it to durable history.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `LocalAttachmentStore`, `Config` schema, defaults |
| [`src/store.ts`](src/store.ts) | Content-addressed write and verified read: staging, hard-link publish, fsync chain, digest verification |
| [`src/normalization.ts`](src/normalization.ts) + [`src/encoding.ts`](src/encoding.ts) | Provider-independent normalization and bounded format/quality candidates |
| [`src/request-image.ts`](src/request-image.ts) | Route-specific request transforms, cache identity, and singleflight |
| [`src/image.ts`](src/image.ts) | Full raster decode and metadata verification |
| — | No runtime invariant companion is published; immutable writes and verified reads are enforced directly at the backend boundary. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

For the full service contract and payload types, read the subsystem reference; for the capability this storage backs, read the seam package.

- [Attachment subsystem reference](../../../docs/subsystems/attachment.md) — service contract, payload types, and the `ctx.attachments` cordis surface.
- [Attachment seam package](../attachment/README.md) — the image attachment capability this storage backs.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-attachment-local) — every accepted config field and its source declaration.
- [Home paths resolution](../../util/home-paths/README.md) — how `DSH_HOME` resolves from explicit config, environment, and the user home.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through request descriptors. A mapped execution filesystem lets the model see each image's identity, dimensions, media type, read-only process path, writable-copy extension, and normalization warning alongside the request bytes.

#### KV Cache effect

Normalization and request projection are deterministic. An unchanged attachment and route policy reuse identical cached request bytes on later turns; execution-world path mapping can change descriptor text without changing those bytes or their `variantId`.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what this storage can and cannot do; they are current package constraints.

- **Images are kept forever** — stored images are never deleted automatically, and nothing collects unreferenced objects.
- **Local to this machine** — images live on the machine that runs the harness; other hosts cannot read them.
- **Animated GIF becomes static** — normalization retains only the first frame; animation is outside the version-one image contract.
- **Encoder output is versioned** — the installed Sharp/libvips build pins normalization and request bytes; an encoder or transform-version upgrade re-addresses future variants while existing objects remain valid.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and the package code.

#### Future: retention and remote storage

Retention and garbage collection are deferred because resumed and forked sessions may share immutable objects, and a backend serving remote runtimes or shared storage would need its own durability proof. Both directions are undecided; the local storage currently retains every object under `DSH_HOME`.

</details>
