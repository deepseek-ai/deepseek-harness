# Agent Note: Execution-world image paths in model requests

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-21-model-readable-image-paths.zh.md)

## Problem

An uploaded image becomes an opaque durable `ImageAttachmentRef`. Image-capable models receive its request preview, but the prior descriptor gives them no filesystem location for later image operations. Agents consequently search the workspace and temporary directories or ask the user where the file is. The request preview and stored normalized attachment may both differ from the upload, so their dimensions, format, and byte size cannot establish the upload's original properties.

## Decision

`ImageAttachmentRef` remains portable session data and contains no host path. `AttachmentStore.imageHostPath(ref)` exposes only the attachment provider's optional host object location. The local provider derives that absolute path from the resolved `DSH_HOME`, attachment storage version, and validated digest; it does not inspect the model-tool execution world.

Each LLM provider plugin supplies the bridge at request assembly. It combines the attachment store with the current `ctx.fs.processPathFromHostPath(hostPath)` mapping and passes the resulting `ImageAttachmentAccess` independently into retained-image serialization and offload placeholders. The filesystem service is authoritative for this question because the mounted filesystem and subprocess providers share one execution world. A separate subprocess-presence check would not prove path reachability. Host-backed filesystems return a process path; E2B and other remote backends without a shared mount return no mapping.

`RequestImageAttachment` remains a deterministic version selected by the attachment and route policy. It contains `variantId`, encoded bytes, dimensions, and encoding metadata, but no access path. Execution-world access may change with the host or mounted providers and does not participate in `variantId`.

The shared LLM image descriptor names the display name or full attachment id, the exact request-preview dimensions, and the execution-world path when the bridge resolves one. Local access text includes normalized dimensions and media type, identifies the object as read-only, directs the model to copy it to a writable path with the matching extension before editing, and states that normalization or request projection may have resized or re-encoded the upload. DeepSeek Files and pi-ai inline requests use the same descriptor.

Request-size offload requires a per-image placeholder function; the previous shared placeholder constant and its byte-bound wrapper had no remaining production caller and are removed. DeepSeek and pi-ai replace each omitted occurrence with its own attachment identity and access resolved for that request without reading or transforming the omitted object. Offload selection, byte accounting, and quantized prefix behavior remain unchanged.

Descriptor identity comes from each occurrence's own durable reference, not from the prepared request version: versions are deduplicated per attachment id, so two uploads of the same content under different names share one version while each occurrence keeps its own display name. Host-location resolution validates the logged attachment id; a malformed reference in durable history fails the request at assembly, the earliest point that resolves it.

Absolute paths stay out of session events and request-image versions. Model-visible path text is reconstructed from the logged attachment reference, the current attachment provider, and the filesystem mounted for the current execution world. Restoring the same session with a different `DSH_HOME` produces the path valid on that host; restoring it with a remote execution world that has no shared mount produces no path. Published attachment objects use owner-read-only mode, including deduplicated objects, and model instructions require a writable copy for modifications.

## Alternatives considered

**Persist the absolute path in `ImageAttachmentRef`.** A durable host path becomes stale after moving a session, changing `DSH_HOME`, or mounting another provider. Resolving it at request time preserves portable history.

**Teach each LLM adapter the `~/.dsh` layout.** Explicit `dshHome` and `$DSH_HOME` can select another root, and non-local providers may expose no path. The attachment provider owns the object location; the shared LLM helper owns the composition with an execution-world mapper.

**Let the attachment provider inspect `ctx.fs`.** The attachment provider knows where its object lives but does not own the model tools' execution environment. Combining both services in the LLM consumer also avoids a package reference cycle between attachment, filesystem, and LLM definitions.

**Store `ImageAttachmentAccess` in `RequestImageAttachment`.** Request versions are deterministic cache and upload values. A path that changes with the host or execution environment must not affect their identity or appear to be part of their reproducible data.

**Infer path sharing from the filesystem provider's package or class name.** Provider identity does not establish that a host file is mounted into its execution world. The filesystem provider instead answers the exact mapping question and can support an explicit shared mount without changing the attachment provider.

**Add a dedicated crop or recovery tool.** Standard filesystem and image tools can operate after copying the normalized object. A new tool adds a model schema and access-policy surface without being necessary for path discovery.

## Verification

Package tests cover provider host-location defaults, host-backed path mapping, absence without a mapped filesystem, digest-to-path resolution, owner-read-only publication and deduplication, access passed independently from request versions, retained-image descriptions, per-image nested offload placeholders, source-property warnings, and matching extensions. A keyless assembled ACP snapshot checks the exact local object path in both a retained DeepSeek Files image handle and an offloaded image placeholder.

## Consequences

When the execution world maps the attachment object, the selected model provider receives its path. This disclosure lets the model operate on the stored image and is limited to normalized attachment objects already in that request's authorized history. Descriptor text adds tokens for every retained or offloaded image. Paths can change while deterministic image bytes, `variantId`, and session references remain unchanged; the changed historical text can prevent KV-cache reuse from the first affected image even when no image is offloaded. Remote execution worlds without a shared mount receive the existing no-path recovery text. A missing local object still fails when a model tool attempts to read it.
