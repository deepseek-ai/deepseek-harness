# Agent Note: Compact Markdown for Thinking

Status: implemented

English | [中文](2026-09-17-thinking-markdown.zh.md)

## Problem

Chat Thinking contains model-authored Markdown, but literal rendering exposes headings, emphasis markers, and code fences. The shared answer typography makes headings larger and more prominent than the secondary reasoning text. Trajectory applies that answer typography to the same reasoning.

## Decision

[MarkdownText](../../../../packages/client/ui-primitives/src/markdown/MarkdownText.tsx) owns a compact presentation variant used by Chat Thinking and Trajectory thinking details. It keeps the secondary content font size, line height, and tertiary color throughout. Heading levels retain semantic elements but share the same 600 weight and size; paragraphs, lists, quotes, and code use compact spacing. Links keep a resting dotted underline with tertiary color as a secondary-content exception to the [shared link styling](../../../../docs/web-styling.md); code retains its monospace font and background.

Tables and formulas remain enabled through the existing parser. Their containers constrain horizontal overflow, and formula text inherits the secondary font size. Inline formulas retain native KaTeX baselines; enclosing text blocks own overflow so short formulas do not create scrollbars. Compact code banners stay in normal flow, keeping the [Thinking disclosure header](../../../../packages/client/ui-chat/src/client/chat/ReasoningRow.module.css) above the scrolling content without a second sticky band.

Chat passes its running state to the existing incremental Markdown renderer. The collapsed summary remains a separate single-line text projection. The parser, frozen-block cache, stored reasoning, and Session format do not change. Trajectory pins Thinking to its inspector’s fixed 13px/20px tier, independent of Chat’s content-size setting. Its answer output retains its existing typography and its [Thinking disclosure behavior](../feature/2026-09-09-ptc-trajectory-code-inspection.md).

## Alternatives considered

**Use answer typography unchanged.** Large headings and generous block spacing give reasoning more visual weight than the answer.

**Style Markdown separately in each consumer.** Chat and Trajectory would need to track the same renderer elements independently; the primitive owns those elements and their compact presentation.

**Disable tables and formulas.** The existing renderer already supports them. Bounded overflow and inherited font sizing preserve useful content without another parsing mode.

## Consequences

Thinking supports structured reading while retaining its secondary emphasis. Semantic headings remain available to assistive technology even though their visible hierarchy is flattened. The shared variant applies to both views; future Markdown element changes must preserve its typography as well as the default answer typography.

Markdown soft line breaks collapse like answer prose; hard breaks and separate paragraphs require Markdown syntax. Streaming freezing operates on completed blocks, so an unfinished long paragraph remains in the mutable tail and is parsed again as it grows.
