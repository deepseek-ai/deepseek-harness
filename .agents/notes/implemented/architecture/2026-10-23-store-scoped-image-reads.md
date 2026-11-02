# Agent Note: Image reads use attachment-store access

Status: implemented

English | [中文](2026-10-23-store-scoped-image-reads.zh.md)

## Problem

Historical image loading read the requesting Session and searched its event content for every uncached attachment. The search established that the Session referenced the image; it did not locate the bytes, whose storage path already follows from the content-addressed ID. This added work proportional to history length to each image read. The reported loading delay also involved uploads; this finding alone does not identify all of that delay.

## Decision

Session membership is not an image-access restriction. After connection authentication and Gateway permission checks authorize `session/attachment`, every caller may read any image in the same attachment store using a complete `ImageAttachmentRef`, including objects referenced only by other Sessions or not referenced at all. The request retains `sessionId` for the existing Session resource permission check. After that check passes, the handler does not require that Session to exist and does not return `session/not-found` solely because it is absent. No identity receives a separate history-scanning path.

The Client already holds the message's complete image reference and sends it as `attachment` beside `sessionId`. Session Controller delegates directly to the existing `AttachmentStore.readImage(ref)`. Its local provider validates the canonical ID, derives the path within its object directory, verifies SHA-256, and compares the actual format, byte length, width, and height with the supplied reference. A missing, unreadable, corrupt, or mismatched object rejects the operation. No Session history is needed to recover the reference.

The response preserves the supplied reference. Its optional `name` and `originalDimensions` are caller-supplied display information and are not verified against the stored object. The Client's existing historical-image cache continues to own per-Session results and object URLs; the Host adds no image-byte cache.

This rule narrows the readers covered by [Session observations](2026-08-25-session-observations-and-projection-owned-client-state.md) and the [history transport activation policy](2026-08-18-session-history-and-event-transport.md). [Workspace file reads](2026-09-05-workspace-files-service.md) keep their own filesystem authorization.

## Alternatives considered

**Keep a Session-to-image map or projection.** An index removes repeated scans but preserves an access restriction the product does not require, adding derivation, lifetime, and invalidation work.

**Issue signed image tickets.** Tickets add issuance and validation state for the same unnecessary Session-membership restriction.

**Optimize only owner reads.** That gives identities different image-access semantics and leaves the scan cost for permitted non-owner callers without a product requirement.

## Consequences

Knowing a valid image reference and having permission to invoke the endpoint for the supplied Session resource permits reading that object across Sessions. The local ID is the SHA-256 of normalized bytes. For known PNG, JPEG, or WebP bytes that admission preserves unchanged, a caller can calculate the ID, derive the format, byte length, and dimensions, and use an authorized read to test whether the object exists. The required reference fields need not come from a Session log.

Image isolation requires separate Host instances with separate `DSH_HOME` directories. The shipped composition uses one attachment store per Host and does not select a store by Session. Authentication, Gateway action/resource checks, fixed storage paths, digest verification, and explicit failures remain required.

Image reads no longer depend on history length or Session materialization. File reading, integrity verification, encoding, and transport still cost time; this change makes no claim about upload or model inference latency. Existing Session data and fork references need no migration.

## Verification

The read-path invariant is zero Session-history queries or traversal for attachment reads. Coverage must distinguish a permitted cross-Session image read from a denied Gateway call and exercise valid references, invalid IDs, mismatched intrinsic metadata, preserved optional display fields, missing and corrupt objects, old history pages, and inherited fork images. Performance evidence must separate historical scanning, storage work, and transport rather than attribute the entire reported delay to the scan.

The diagnostic is [`image-read.perf.ts`](../../../../packages/api/session-controller/tests/image-read.perf.ts), compiled by its [tsdown configuration](../../../../packages/api/session-controller/tests/image-read.perf.config.ts). The baseline worker pairs the pre-change controller with `{ sessionId, attachmentId: ref.attachmentId }`; the candidate worker pairs the current controller with `{ sessionId, attachment: ref }`. Both use the same image fixtures, workload, and output checks, and run against the same built Local store with `readImage(ref)` verification. From the candidate checkout root, compile and run:

```sh
pnpm exec tsdown --config-loader native --config packages/api/session-controller/tests/image-read.perf.config.ts
(cd packages/api/session-controller && node --expose-gc .dsh-build/image-read/image-read.perf.js --expect-no-history)
```

Run the separately compiled baseline worker without `--expect-no-history`; its diagnostic request must match the baseline controller's ID-only request fields. The baseline negative control adds `--sample typical --expect-no-history` and must fail because that implementation queries and traverses history. The parent process runs each workload in five fresh child processes, each with a loaded Session and a first uncached read of every image. Images are deterministic synthetic 1024 × 768 PNGs; the two workloads contain 120 turns, 960 events, and 8 images, or 2,000 turns, 16,000 events, and 32 images. Fixture writes can leave the operating system's file cache warm.

`controllerMs` covers the direct controller call through base64 return. `storeMs` includes file I/O, SHA-256, and header verification; `snapshotMs` measures history snapshot acquisition separately. `scanAndDispatchMs` is the time before store entry minus `snapshotMs`, so it includes dispatch overhead and is not an isolated scan timer. JSON serialization and loopback HTTP transfer are separate measurements over retained responses. `requestJsonBytes` and `idOnlyRequestJsonBytes` compare serialized request lengths; they do not measure request transmission time. Cold Session restoration, Gateway processing, browser rendering, remote-network latency, upload, and model inference are excluded. PR #7021 records the worker revisions and before/after results under these limits.

The memory endpoints run GC after fixture setup and after all image responses. The Session, admitted image references, and every base64 response remain reachable at the second endpoint. These retained endpoints include setup-owned objects, and peak RSS is cumulative from process start, including fixture generation. They do not measure image-request memory in isolation or impose a retained-memory budget.
