# Agent Note: Binary workspace file transfer

Status: implemented

English | [中文](2026-09-17-workspace-file-binary-transfer.zh.md)

## Problem

Document previews need native bytes. Encoding file contents as base64 adds about one third to the payload before compression and requires browser decoding. A separate file Fetch route also duplicates the Gateway's method dispatch, Session lookup, and error handling.

## Decision

The [Remote method architecture](2026-08-02-typert-remote-method-calls.md) owns method dispatch and lifetime; this note defines binary success encoding and Client validation. The [workspace file service](2026-09-05-workspace-files-service.md) exposes one binary `readBytes` Remote. Its required options object independently selects a byte `range` and a `baseFile` for relative target resolution. Without `range`, it reads a complete file. This avoids separate method names for orthogonal choices while preserving bounded `fs.readBytes` and `fs.readByteRange` reads.

Typert recursively recognizes `Uint8Array` in unary result types, including root values, optional fields, and containers. Generated result codecs provide `encode()` for subtrees whose types can contain bytes and `decode()` to validate the reconstructed value without iterating, copying, or freezing byte payloads; Client declarations narrow each byte buffer to `ArrayBuffer`. Gateway executes the generated encoder, keeps strict JSON values unchanged, and performs runtime byte detection for source-mode calls. It returns JSON-compatible metadata and result-relative byte attachments to Connection. Connection owns standard `FormData` parts and preserves the RPC envelope and correlation id in JSON metadata; it does not inspect business values or depend on Typert reflection. An attachment table associates byte parts with paths through the JSON result; field names remain business-owned. The Client restores `Uint8Array` views over `Blob.arrayBuffer()` and Gateway delegates validation to the generated decoder. Ordinary results and errors retain JSON responses. Gateway owns method dispatch, Session lookup, cancellation, result projection, and mount lifetime; feature code needs no multipart reader or dedicated route.

## Alternatives considered

- Separate `readAll`, range, and related-file methods mix independent path and extent choices. One options object permits their combination without adding another method.
- A workspace-only Fetch route keeps binary transport out of Remote but requires feature-specific dispatch, Session lookup, and error decoding.
- A whole-result binary marker or a reserved `data` field couples transport to one business result. Type-directed codecs and attachment paths support independently named and nested fields without adding result-wide categories.
- A custom metadata prefix needs owned framing and length validation. FormData delegates those mechanics to the platform, at the cost of Blob copies.
- Metadata HTTP headers constrain long Unicode paths. Multipart fields keep paths in the body; HTML stays in an isolated Blob iframe rather than a navigable Host response.

## Consequences

Byte ranges retain only the requested bytes under `maxBytes`, independently of `maxFileBytes`. Complete reads retain a bounded whole file; this is not a streaming preview or zero-copy optimization. On HTTP disconnect, the bridge aborts the request signal and drains materialized response chunks without writing to the socket: cancelling Node multipart bodies can race their producer and cause an unhandled `ERR_INVALID_STATE` rejection. Office authorization probes use the same Remote with a one-byte range; converted PDFs remain base64 in the separate Office Remote and use its bounded decoder. Plugin callers migrate to `readBytes` options and stop decoding its data as base64. Binary arguments, events, and stream items remain unsupported; recursive types require acyclic runtime values. No Session event or persistence format changes.

## Validation

Workspace tests cover complete and ranged reads, combined base-file resolution, limits, Session lookup, cancellation, and binary RPC round trips. Connection and Gateway tests cover nested and multiple attachments, framing, correlation, malformed multipart, and cancelled or withdrawn calls; Typert tests cover recursive result codecs, Client declarations, and rejected binary inputs or streams. The built browser scenario checks raw PNG bytes plus HTML, PDF, image, and text previews. Local benchmarks compare full and ranged reads using identical synthetic files, and distinguish transport/decoding from the complete read path.
