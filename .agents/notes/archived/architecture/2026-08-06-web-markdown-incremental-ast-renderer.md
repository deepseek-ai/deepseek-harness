# Agent Note: Incremental streaming markdown through a direct mdast renderer

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-web-markdown-incremental-ast-renderer.zh.md)

## Problem

`MarkdownText` re-parsed the whole accumulated reply on every streaming publish: react-markdown's string-only API builds a fresh unified processor per render and runs micromark → mdast → hast → React over the full text, so per-chunk main-thread work grew linearly with the reply and the stream's cumulative cost grew quadratically. The existing mitigations (frame batching, the isolated streaming tail, the plain fence arm) bounded how often and how widely that work ran, never how much text each run re-parsed. Fixing it needs AST-level input — freezing settled blocks and re-parsing only the source tail — which the string-only wrapper structurally cannot express.

## Decision

`MarkdownText` renders mdast directly and parses incrementally while streaming:

- **Grammars** ([parse.ts](../../../../packages/client/ui-primitives/src/markdown/parse.ts)): `parseGfm` (streaming arm and `extractMarkdownPlainText`) and `parseGfmWithMath` (settled arm) call `mdast-util-from-markdown` with the same micromark extensions the replaced remark plugins wrapped, so block boundaries are identical everywhere. `mathCompatibility` (ex `remarkMathCompatibility`) now exports its micromark extension directly.
- **Incremental parsing** ([incremental.ts](../../../../packages/client/ui-primitives/src/markdown/incremental.ts)): CommonMark block parsing is line-based, so appended text reshapes only the parse frontier. `IncrementalMarkdownParser` keeps the trailing two blocks unstable (the last block is the frontier; the second-to-last is safety margin), freezes everything before them, and re-parses only the source tail from the last frozen block's `position.end.offset` — the parser's own offsets, no bespoke source scanning. Each source region parses O(1) times per stream instead of once per chunk; a single giant block (an unclosed fence) degrades to the old full-reparse cost and no worse. Non-append input resets the state under a bumped generation.
- **Rendering** ([render.tsx](../../../../packages/client/ui-primitives/src/markdown/render.tsx), [katex.tsx](../../../../packages/client/ui-primitives/src/markdown/katex.tsx)): one switch over mdast node types replaces remark-rehype + react-markdown, reproducing the replaced pipeline's DOM byte-for-byte — table alignment as `text-align` styles, tight-list paragraph unwrapping, task-list classes and checkbox spacing, the footnote section (whose in-page anchors the protocol allowlist already reduced to plain text), literal raw HTML, the separator newlines that surface next to literal HTML text, and rehype-katex's three-arm error chain with KaTeX HTML mapped to React through the browser's own `DOMParser` (no wrapper element, so first/last-child margin rules still reach `.katex-display`; React 18 puts the `.katex-mathml` subtree in the HTML namespace exactly as the replaced pipeline did — a pre-existing limitation outside this parity contract, invisible to the visual `.katex-html` arm). Frozen blocks cache their React elements and keep source-offset keys, so crossing the freeze boundary reconciles instead of remounting; `MarkdownText` is memoized.

The DOM is pinned by `tests/fixtures/markdown-dom`: fixtures recorded from the react-markdown implementation before the swap, which the new renderer must reproduce under a whitespace-normalizing serializer. A fixture diff is a user-visible markdown style change to review, never to re-record for a refactor. `tests/markdown-incremental.spec.tsx` holds the equivalence property — at every appended prefix, chunked at 1/3/7/16 bytes, the live component's DOM equals a fresh mount's — plus freeze-boundary DOM-node identity and reset behavior.

This reverses the [assistant-markdown note](../feature/2026-07-23-web-assistant-markdown.md)'s rejected alternative ("maintain a custom React walker"): the incremental requirement is new evidence, the walker's security-sensitive branches (URL allowlist, image policy, inert HTML) were already product-owned functions, and the dependency no longer deleted owned code — it blocked the architecture. That note's untrusted-output policy and renderer selection are unchanged.

## Alternatives considered

**Keep react-markdown and split the source into per-segment `<ReactMarkdown>` instances.** Zero renderer ownership, but each frame parses the tail twice (boundary detection + render), settled math still re-parses everything, hast construction and the per-render processor remain, and blocks remount when crossing the freeze boundary because element trees cannot be cached across instances.

**Render cached mdast through `mdast-util-to-hast` + `hast-util-to-jsx-runtime`.** Keeps upstream's node mappings for free, but retains the hast intermediate per frame and two new direct dependencies for a pipeline whose mapping surface is small, closed, and now pinned by fixtures.

**Parse KaTeX output with `hast-util-from-html-isomorphic` (as rehype-katex does).** Pulls a parse5-based HTML parser into the bundle to parse trusted, vocabulary-constrained KaTeX output the browser's `DOMParser` (with the spec's SVG/MathML attribute adjustments) already parses identically.

## Consequences

Streaming per-chunk work now tracks the unstable tail instead of the whole reply, and react-markdown, remark-gfm, remark-math, rehype-katex, unified, and the hast chain left the browser bundle (`mdast-util-math` and `micromark-util-sanitize-uri` became direct dependencies; both were already transitive). The package owns ~25 node mappings, their tests, and the KaTeX DOM conversion — priced against the fixture contract that freezes their output. Two behavioral deviations, both healed by the settled full parse at finalize: a reference-style link or footnote whose definition lands on the other side of a freeze boundary renders literally while streaming, and a footnote reference can flash back to literal text when its definition freezes while the referencing block is still unstable. This module and KaTeX conversion assume a browser DOM (`DOMParser`), which the client-only package already did.
