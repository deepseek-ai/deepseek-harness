# Agent Note: Remote Web Markdown images

Status: implemented
Archived: 2026-09-30

English | [中文](2026-07-30-web-remote-markdown-images.zh.md)

## Problem

Assistant Markdown can name diagrams and screenshots with standard image syntax, but the Web renderer replaces every image with italic alt text. Even absolute HTTP(S) destinations therefore lose ordinary Markdown behavior.

## Decision

`MarkdownText` renders absolute HTTP(S) image destinations as lazy, responsive `<img>` elements with asynchronous decoding and `referrerPolicy="no-referrer"`. Relative paths, absolute local paths, `file:` URLs, and unsupported schemes retain the existing alt-text fallback. Raw HTML stays disabled, so an assistant cannot bypass the Markdown image component with a hand-authored `<img>`.

The image component reuses the renderer's absolute-URL policy without adding a host proxy, local-file route, Session dependency, sanitizer, or image fetcher. Finalized history, streaming output, interrupted partials, and every other `MarkdownText` consumer receive the same behavior.

## Alternatives considered

**Keep all images as alt text.** This preserves the smallest network boundary but defeats the product need to inspect network-hosted visual artifacts inline.

**Proxy remote images through the host.** A proxy could hide the browser's network address from the image origin, but it would make the host perform arbitrary outbound fetches and require a separate redirect, DNS, size, and content policy. Direct HTTP(S) loading keeps that request visible to browser controls; omitting the referrer limits conversation-origin disclosure.

**Support local paths in the same change.** Web origins cannot directly load host files. A safe implementation needs a separately reviewed authority boundary, so relative paths, absolute local paths, and `file:` URLs remain disabled.

**Allow `data:` images.** Large data URLs duplicate binary content into durable transcript text. The HTTP(S)-only policy covers the current need without expanding session logs.

## Consequences

Assistant replies display remote images during streaming and replay without changing session events or host protocols. Remote origins still observe the image request, client network address, and any credentials that browser policy permits for that origin. Local and unsupported destinations remain inert alt text.
