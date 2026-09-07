# Agent Note: Safe assistant Markdown in the Web conversation

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-23-web-assistant-markdown.zh.md)

## Problem

The Web conversation preserves assistant Markdown source through session events, history replay, and streaming accumulation, but its terminal text primitive renders that source literally. Changing the shared primitive would also format user and steering messages, while parsing in the runtime would mix presentation state into the React-free session projection.

## Decision

`@deepseek-ai/dsh-client-ui-primitives` exports `MarkdownText` as the untrusted assistant-text renderer, and `ui-conversation` selects it only for assistant `text` blocks. Finalized history, the streaming tail, and interrupted partials already share `AssistantMarkdown`, so they receive the same renderer without changing events or snapshots. User and steering messages render through `projectUserText` (inline plain runs plus reference chips) and remain literal.

`MarkdownText` parses with `mdast-util-from-markdown` plus the GFM micromark extensions and renders the mdast tree through the package's own renderer, parsing incrementally while a turn streams (the [incremental AST renderer note](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.md) owns that mechanism and its DOM-parity contract). It covers CommonMark blocks plus GFM tables, task lists, strikethrough, and autolinks without raw-HTML parsing. A micromark attention extension reuses the CommonMark resolver while letting runs of at least two asterisks close after Unicode punctuation when followed immediately by CJK text. This exception covers punctuation-terminated strong emphasis in whitespace-free CJK prose during streaming and after settlement; single-asterisk emphasis, non-CJK adjacency, escaped source, code, and math retain upstream parsing. Fenced code routes through the shared `CodeBlock`, which highlights registered grammars with the client's shiki singleton (`--shiki-*` tokens) and falls back to plain monospace otherwise. While a turn streams, fences highlight incrementally: each chunk tokenizes newly completed text from a saved grammar state plus the still-growing last line, excluding the completed prefix from repeated work (the [streaming fence-highlight note](2026-08-20-web-streaming-fence-highlight.md) owns that mechanism).

Visual spacing, tables, links, blockquotes, inline code, and code-block chrome follow deepsuite `@deepseek/md` (`markdown.css` / `code-block.css`) and the same `--dsw-alias-markdown-*`, `--dsw-font-markdown-*`, `--dsw-alias-border-l*`, and `--dsw-alias-label-*` tokens. Links use `--dsw-alias-state-business-primary` (deepsuite's sheet uses `--dsw-alias-brand-text`, which is blue only under newDesign; design-platform keeps brand-text near-black and is not retuned here). When one inline-code token consists entirely of an absolute HTTP(S) URL, its code chrome contains the same keyboard-focusable safe external anchor as an ordinary link; port, path, and query text remain unchanged, while commands, partial URLs, other schemes, and fenced code stay inert. `CodeBlock` ships a language banner and a copy control (`复制` / `复制成功`). Finalized text renders KaTeX through the settled grammar's math extensions; `mathCompatibility` maps `\(...\)`, `\[...\]`, and block-level same-line `$$...$$` to the same standard math AST nodes. This is a narrow parser compatibility layer, not a regex rewrite or malformed-model-output repair. Streaming stays literal until finalization so incomplete formulae do not flash errors. Citation pills, heading anchors, the thinking-small markdown variant, and custom □/☑ task markers remain out of scope; GFM task lists keep native checkboxes.

The dependency is explicit in `ui-primitives`; because that pure library is seeded by the Web shell, the parser and highlighter are part of the initial browser bundle.

## Untrusted output policy

Assistant-authored link destinations are restricted to absolute HTTP, HTTPS, and mailto URLs. HTTP(S) links open in a new tab with `rel="noopener noreferrer"`; relative destinations and other protocols render as non-navigable text. Markdown images follow the separate [remote-image policy](2026-07-30-web-remote-markdown-images.md). Raw HTML remains inert source text because no HTML parser enters the pipeline. Shiki output is a static span tree generated from the fence text (no scripts or user HTML).

Fenced code and GFM tables own horizontal overflow so long content cannot widen the conversation column.

## Alternatives considered

**Promote the existing mdast and micromark development dependencies and maintain a custom React walker.** This avoids a new parser family but makes the product own every node mapping, GFM extension, and security-sensitive rendering branch. The dedicated React renderer keeps that traversal upstream while preserving an AST-to-React path. *Later reversed on new evidence — incremental streaming parsing needs AST-level input the string-only wrapper cannot provide; the [incremental AST renderer note](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.md) owns that decision.*

**Render user prompts and steering as Markdown too.** This formats authored input as a side effect. Those authored inputs remain literal until the product chooses that behavior explicitly.

**Parse Markdown into session snapshots.** This would make React nodes or presentation ASTs durable runtime state and reintroduce a final-versus-streaming mode boundary. Parsing stays at the presentation leaf instead.

**Enable raw HTML with sanitization.** Raw HTML has no current product need and would enlarge the executable-content boundary, so it remains disabled rather than adding a sanitizer dependency. Remote images are governed by the later [image policy](2026-07-30-web-remote-markdown-images.md).

**Port deepsuite Prism `highlight.css` and the mdast pipeline.** Appearance parity is owned by CSS Modules and shared `--dsw-*` tokens; highlighting stays on the existing shiki allowlist so the client does not take a second highlighter or Prism class contract.

**Preprocess Markdown source or repair text nodes after parsing for CJK punctuation boundaries.** A source rewrite must reproduce escape, code, math, and delimiter rules before the parser owns those distinctions, while a text-node repair has already lost some source intent and cannot compose with parsed inline nodes. Extending attention at the tokenizer boundary preserves the upstream resolver and limits the divergence to delimiter eligibility.

**Require the model to emit standard links and leave URL-shaped inline code inert.** Output guidance cannot make persisted or third-party model replies uniform, and inline code is a common way to distinguish a literal endpoint. Recognizing only a complete absolute HTTP(S) value at the rendered inline-code boundary preserves code semantics while applying the existing untrusted-link policy.

## Consequences

Assistant replies render semantic Markdown consistently during streaming and replay, while tool cards, reasoning rows, interactions, user bubbles, and the host protocol remain unchanged. Streaming reparses only the unstable tail after each accumulated update; incomplete Markdown can temporarily change the tail's structure, but the isolated tail bounds React invalidation and the final event does not switch renderers. URL-shaped inline code becomes navigable without changing its visible literal, while unsafe schemes and mixed code remain non-interactive. Code fences share one chrome and copy path with tool and details surfaces. The initial Web shell includes the Markdown parser, GFM runtime, KaTeX, and shiki allowlist; citation, anchor, and thinking-small surfaces remain deferred.
