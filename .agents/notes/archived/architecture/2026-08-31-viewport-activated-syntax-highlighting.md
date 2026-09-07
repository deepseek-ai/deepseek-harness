# Agent Note: Viewport-activated syntax highlighting

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-31-viewport-activated-syntax-highlighting.zh.md)

## Problem

A long conversation mounts code fences and read cards far outside the visible viewport. Eager highlighting tokenizes every supported block and creates every token span during that mount, so main-thread work and DOM size scale with the whole rendered history rather than the code the reader can see. The [Shiki selection](../process/2026-07-26-web-syntax-highlighting-shiki.md) and [incremental streaming highlighter](../feature/2026-08-20-web-streaming-fence-highlight.md) bound initialization and repeated prefix work, but neither avoids the first per-block tokenization for unseen history.

## Decision

`useViewportHighlighting` owns one shared `IntersectionObserver` for syntax-highlightable `CodeBlock` and `ReadBlock` instances. A supported block renders its existing plain-text arm until its root first intersects the viewport. An absent or unsupported language never registers with the observer. A browser without `IntersectionObserver` activates highlighting after mount so the capability still works.

The first intersecting entry removes its target from the observer and activates that component for the rest of its lifetime. Leaving the viewport never returns it to plain text. This one-way transition avoids repeated tokenization, token-DOM construction, and visual churn while scrolling. The shared observer disconnects when no inactive registered blocks remain.

`CodeBlock` gates both settled `highlightToHtml` calls and streaming `StreamingHighlightSession` creation. It starts an activated stream from the current accumulated source, then retains the existing incremental tokenizer and React line caches. `ReadBlock` gates `highlightLines` while retaining its line rows and gutter. The plain and highlighted arms keep the same source text, code font, padding, wrapping, and line height; Shiki's color, bold, italic, and underline token styles remain unchanged.

The module-level Shiki singleton warm-up remains eager. Viewport activation defers code-block content tokenization and token-span construction, not the fixed boot-grammar warm-up or the plain content DOM.

## Testing

The focused jsdom test replaces the process-global `IntersectionObserver`, mounts several code surfaces, and proves that non-intersecting and unsupported blocks remain plain, intersecting blocks share one observer, leaving the viewport does not remove highlighting, and an activated block continues to highlight changed source. It also covers read-card activation and observer disposal. Each test restores the global and unmounts every component, so the module-level registry cannot leak registrations into another case.

Existing component tests run without `IntersectionObserver` and therefore cover the immediate fallback together with the established Shiki output, font styles, streaming caches, and plain-language behavior. Browser geometry is not measured by this unit suite; geometry stability relies on the unchanged shared typography and box styles of the plain and highlighted arms.

## Alternatives considered

**Deactivate highlighting when a block leaves the viewport.** This can reclaim token DOM from blocks already viewed, but scrolling repeatedly rebuilds the same token tree, discards streaming caches, and changes visible presentation at both viewport edges. One-way activation pays the cost at most once per mounted block.

**Drop bold and italic token styles to make every token use identical font metrics.** This weakens syntax presentation, especially for highlighted Markdown, and is unnecessary for the chosen lifecycle: both render arms already use the same code font and fixed line height. Shiki's existing token styles remain intact.

**Pin a measured pixel height during activation.** A fixed measurement becomes stale when a streaming fence grows or responsive wrapping changes, and can clip content or introduce an inner vertical scrollbar. The plain arm stays in normal flow instead of adding measurement state.

**Virtualize complete code blocks or retain only a token window.** This can also bound DOM after a reader has visited every block, but it changes selection, copy, scroll anchoring, and streaming-cache ownership. Viewport activation removes unseen work without changing those behaviors.

## Consequences

Supported code that is never viewed incurs no content tokenization and creates no token spans. The first viewport intersection pays the normal synchronous highlight cost; a lazily imported grammar may keep the block plain until its existing load notification arrives. Activated blocks retain their highlighted DOM when scrolled away, so memory use grows with blocks the reader has visited rather than shrinking with the current viewport.

The optimization is local to presentation. Markdown parsing, Shiki grammar selection and styling, stream-tail tokenization, copy text, and settled output remain unchanged.
