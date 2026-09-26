# Agent Note: Bounded shared Office conversion

Status: implemented

English | [中文](2026-09-15-bounded-office-conversion.zh.md)

## Problem

Office preview and explicit document inspection can request the same conversion. A completed-result cache alone leaves source reads, queued payloads, and concurrent readers unbounded. Speculation can also occupy capacity needed by a user, and canceling one consumer must not destroy another consumer's conversion.

## Decision

The `office-to-pdf` service returns complete PDF bytes. Its Remote file entry authorizes Session files through `workspaceFiles`, while its in-process conversion accepts authorized deferred reads without requiring that service. The `api/remotes` assembly owns Client namespace mounting. Page rasterization and user presentation remain separate consumers, so conversion naming does not imply image rendering or preview UI.

The [Host provider](../../../../packages/document/office-to-pdf/README.md) owns a shared conversion queue and transient content cache. Authorized source metadata enters admission before source bytes are loaded. The source callback receives reserved byte capacity and returns its read version; changed sources fail without publishing aliases. Exact source bytes and Office extension determine the digest. Each converter lifetime adds a generation so engine/font/configuration replacement invalidates reuse.

A bounded source-version index avoids repeated reads after authorization; the digest remains the identity for sharing conversion across distinct paths. Ready PDFs use an entry/byte-bounded LRU. Queued jobs contain metadata and deferred callbacks. Reader, queue, source-byte, and conversion limits also apply before work completes. Each active source locator belongs to live readers, so cancellation cannot grow retained source metadata independently of reader admission. Unknown source sizes reserve the input cap; cancellation retains active capacity until actual read/conversion cleanup settles.

Foreground preview and explicit QA requests precede background work. Disabling background conversions rejects speculative readers before they can join queued or running jobs, while completed alias hits remain available. Removing a queued foreground blocker immediately admits eligible background work. Queued priority follows live readers: a foreground join promotes a prewarm, and the final foreground cancellation demotes it and admits eligible work. Full queues evict queued speculation for foreground admission. Background concurrency reserves a foreground slot when total concurrency permits it. A speculative admission remains occupied through settlement, so promotion cannot admit additional speculation into capacity reserved for user work. Shared readers cancel independently, including readers joined after content hashing. The cache owns private output bytes and returns a copy to each caller.

## Alternatives considered

**Cache only completed PDFs.** This cannot bound pending source buffers, engine work, or response fanout, and separate consumers still duplicate conversion.

**Use source metadata as the final cache identity.** Metadata is useful before reading, but distinct authorized paths can contain identical bytes. Content hashing provides cross-path reuse without treating a path as document content.

**Cancel the entire conversion when one reader leaves.** An open preview can share work with speculation or explicit QA. Only the final reader owns cancellation of shared work.

**Build a second prewarm or QA converter.** Independent queues duplicate resource ownership and cannot prioritize shared foreground work.

**Separate service-definition and provider packages for the sole LibreOffice implementation.** They evolve together and have no independent alternative implementation. One `office-to-pdf` package supplies the mountable service without duplicated package, dependency, and release configuration. Native and WASM engine selection remains inside the kit; a second independent implementation can justify extracting an interface from actual consumer needs.

## Consequences

The cache is transient and cannot bypass source authorization. Oversized PDFs can be returned without retention, and failed or canceled conversions are retried on a later explicit request. Source reservations measure binary bytes; Remote base64 expansion, engine RSS, caller-retained output, and PDF.js page memory remain outside those limits. With one configured conversion slot, foreground work waits for an already-running background conversion to finish.

Office preview checks source authorization and versions through Workspace Files, then reads raw input with `fs.readBytes` within its conversion reservation. Office input limits govern that read. The Host conversion path avoids base64 source allocation; PDF responses encode only the converted output.

Controlled source and engine completions verify pre-read admission, content joining, priority, cancellation isolation, delayed resource release, LRU/alias limits, stale versions, and converter replacement. Loader composition and native conversion checks exercise the shared provider independently of presentation consumers.

## Related

The [background scheduling proposal](../../proposed/simplification/2026-09-17-defer-office-background-scheduling.md) questions the need for speculative priority without a production caller; this note remains the authority for the implemented behavior.
