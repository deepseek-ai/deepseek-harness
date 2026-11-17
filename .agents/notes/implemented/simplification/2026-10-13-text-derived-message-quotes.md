# Agent Note: Recognize message quotes from Markdown text

Status: implemented

English | [中文](2026-10-13-text-derived-message-quotes.zh.md)

## Problem

Quote-only content indexes duplicate information in Markdown text and require coordinated prompt, source, echo, and queue metadata. The same visible blockquote can acquire different presentation and direct-input behavior depending on how it was created.

## Decision

Messages contain ordinary Markdown text. The shared blockquote matcher recognizes consecutive explicitly marked lines for UserText presentation. Hand-written and composer-created blockquotes have identical sent-message behavior. Quote previews display decoded text without running UserText rules over their contents. Session-reference and skill processing applies normally to quoted text; recognized Session labels retain the same presentation as the surrounding quote text.

The [rich-text quote feature](../feature/2026-08-26-web-rich-text-quotes.md) retains atomic draft nodes and semantic restoration spans. This decision supersedes only its durable quote-index distinction. UserText nodes and recognition ranges remain derived values.

## Alternatives considered

**Keep quote-only indexes.** Indexes preserve a distinction between typed and inserted quotes, but that distinction is unnecessary for sent messages and requires metadata coordination across every producer and renderer.

**Remove atomic draft spans.** Plain text cannot restore whole-node editing, undo, Session switching, or failed-send restoration. Draft spans remain browser-owned editing state.

## Verification

Matcher tests cover original offsets, explicit line markers, blank excerpts, and literal nested quotes. Composer tests assert ordinary text submission. The shipped Web scenario checks text-only persistence and quote display after reload.

## Consequences

Messages need no quote fields or content indexes. Typed blockquotes also display as quotes without changing direct-input processing. Recognition deliberately covers explicit quote lines rather than Markdown lazy continuation or fenced-code parsing. Source navigation still requires a separate durable-coordinate design.
