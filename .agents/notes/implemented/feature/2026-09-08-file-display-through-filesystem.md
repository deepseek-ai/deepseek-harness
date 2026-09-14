# Agent Note: Authenticated file display reuses filesystem byte reads

Status: implemented

English | [中文](2026-09-08-file-display-through-filesystem.zh.md)

## Problem

Session prose can reference screenshots in temporary directories or files stored by a remote filesystem provider. A Host-local workspace allowlist cannot serve those paths. An image response without a byte limit can also make the browser download a 1 GiB image before attempting to decode it.

## Decision

The authenticated `/api/file` route reads ordinary files through `ctx.fs`. Authentication and the composed provider's read policy govern access; directory and MIME allowlists do not. This supersedes the serving policy in [the local-media display note](2026-09-07-session-prose-local-media-display.md), which retains renderer ownership and its rationale.

GET calls the existing `readBytes(target, signal, maxBytes)`: providers reject known oversized files before content I/O and enforce the limit while reading. HEAD uses metadata without reading content. `FS_TOO_LARGE` becomes 413. MIME lookup supplies response metadata without sniffing file contents; unknown extensions use `application/octet-stream`. A sandbox CSP prevents directly opened HTML/SVG from executing with the authenticated API origin.

All files use the resolved `ctx.attachments.imageLimits.maxImageBytes` limit, normally 20 MiB. The attachment service owns this deployment setting. All responses contain complete files; Range is ignored and no range support is advertised.

## Alternatives considered

**Workspace and media allowlists.** They limit which authenticated bytes can be read, but exclude ordinary screenshot locations and remote files. The chosen policy permits every regular file the composed provider can read.

**A new filesystem byte-stream API.** Efficient large-file delivery and audio/video seeking would require implementations in every provider, including remote range handling. Complete bounded reads satisfy the current display scope without widening that interface. Streaming and Range can be added when those use cases justify the provider work.

**Duplicate size checks in the route.** GET needs no additional stat/read loop: `readBytes` already owns preflight limits, growth detection, and cancellation. HEAD checks size separately because it must not read the body.

## Consequences

Temporary and remote files use the same filesystem provider as `read_image`, without adding model-facing events. The local sandbox provider constrains mutations and permits reads; an authenticated client therefore has broader access than registered workspace roots. Files remain subject to the provider's permissions and the route's byte limits.

Each GET buffers the complete file in Host memory. Audio/video work as complete responses without incremental transfer or guaranteed seeking. Encoded byte limits do not bound decoded pixel dimensions. Failed image loads show authored alt text or the original destination when alt is empty.

## Testing

Route tests cover sparse 1 GiB rejection before content I/O, post-stat growth, the shared attachment byte limit, ordinary MIME types, temporary paths and symlinks, opaque remote targets, provider failures, metadata-only HEAD, ignored Range, and disposal. Browser expectations cover rendered images, 413/404 and corrupt-image fallbacks, and an image outside the workspace. Remote byte transfer remains owned by the existing filesystem provider tests.
