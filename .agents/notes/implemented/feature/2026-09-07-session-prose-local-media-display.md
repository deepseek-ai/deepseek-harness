# Agent Note: Session prose local media paths display through a same-origin file route

Status: implemented

English | [中文](2026-09-07-session-prose-local-media-display.zh.md)

## Problem

Assistant prose can reference an image by its filesystem path, but browsers cannot read Host files. A renderer limited to absolute HTTP(S) destinations leaves those references as inert alt text. Issue #3662 records this display gap.

## Decision

Local media paths in Session prose render through a same-origin file route. This note owns the renderer vocabulary and its placement; [authenticated filesystem reads](2026-09-08-file-display-through-filesystem.md) owns the current serving policy and supersedes the workspace/media restrictions described below.

`ui-primitives` owns the `MarkdownPathImages` vocabulary on `MarkdownText`. Like `fileMentions`, it applies only after a message settles so frozen streaming blocks cannot cache a vocabulary handler. The settled pass rewrites image destinations outside the remote-URL allowlist and emits only absolute `http(s)`, `blob`, or `data` results. Without a vocabulary, local destinations retain inert alt text. Failed loads replace the image with authored alt text, or its original destination when alt is empty; a different source can load again.

`ui-chat` supplies a page-stable `localPathMediaUrl` vocabulary through `AssistantMarkdown`. It maps absolute POSIX paths to `/api/file?path=…` on the page's origin. Relative and protocol-relative paths, Windows-style paths, and non-HTTP page transports such as Electron `file://` remain inert.

`session-controller` owns the `SessionMediaReferences` contribution beside `SessionFileReferences`. It registers through `connection.fetch`, which applies the same browser authentication and trust checks as `/api` RPC. The fixed same-origin endpoint gives the synchronous renderer a stable URL without an asynchronous capability negotiation.

## Alternatives considered

**Typert gateway or workspace controller ownership.** The gateway owns Remote RPC dispatch, while the workspace controller owns registry lifecycle. Neither owns file-byte presentation; Session Controller is the consumer serving Session prose.

**Session RPC followed by blob/data URLs.** Attachment images can use an asynchronous fetch, but this Markdown vocabulary must synchronously resolve a destination during a memoized render pass.

**Image-only endpoints.** One file route can serve images, audio, and video without separate URL vocabularies. The current implementation returns complete bounded files; Markdown audio/video player nodes remain independent work.

**Byte-signature validation in the route.** The model-facing `read_image` tool owns image admission checks. Display responses describe content by MIME lookup and let browser decoding reject corrupt payloads, avoiding a duplicate signature checker.

**Workspace/media-only access (superseded).** The original policy restricted canonical paths to registered workspace roots and allowed image/video/audio MIME categories except SVG. Regular-file checks before opening rejected pipes and devices; an opened-handle identity comparison narrowed replacement races. These restrictions bounded authenticated access and avoided a per-request interactive authorization flow. They also excluded temporary screenshots and remote files; the successor note records the replacement policy and why those restrictions are not retained.

## Consequences

The Client vocabulary cannot bypass Host authentication or the filesystem provider. The original restricted route distinguished an existing outside-workspace path from an absent path, exposing existence even while refusing its bytes; the successor policy instead permits ordinary provider-readable files.

Windows-style authored paths remain unsupported by the Client vocabulary. Trajectory and tool-card Markdown consumers do not supply this vocabulary, and audio/video Markdown nodes do not render players. These are renderer limitations, independent of the file route's readable MIME types.

The archived [model-readable image paths](../../archived/feature/2026-08-21-model-readable-image-paths.md) note owns the model-facing behavior; this note owns user-facing display and does not supersede it.

## Testing

Renderer tests cover settled and streaming gates, reference-style images, protocol rechecks, failed-load fallback, and replacement sources. Chat tests cover the vocabulary and component wiring. The browser scenario in `apps/web/tests/markdown-images.e2e.ts` boots the shipped Web composition with a seeded Session and checks actual loading and fallback text. A model-driven recorded Session round trip remains separate from this UI expectation; the successor note names current route coverage.
