# Agent Note: Documentation diagram and image viewer

Status: implemented

English | [中文](2026-09-14-docs-mermaid-viewer.zh.md)

## Problem

Complex Mermaid diagrams and interface screenshots lose readable detail when scaled to the documentation column. Readers need both magnification and movement to inspect interactions while retaining an overview.

## Decision

The [VitePress theme](../../../../website/.vitepress/theme/index.ts) adds a corner fullscreen icon to each rendered Mermaid SVG. A native modal dialog provides an inert background and Escape dismissal. Its visible title also names it for assistive technology; a missing or blank page heading uses the localized viewer title. A floating toolbar groups zoom controls, the current scale, and fit; close stays in the top corner, and help opens on demand. Keyboard focus cycles through all five buttons. Panzoom supplies pointer, wheel, and pinch interaction. Arrow keys pan in fixed screen distances. Closing restores the entry's focus without scrolling and restores the page's previous overflow setting.

Ordinary images share one modal and zoom controller with Mermaid. Loaded images with nonempty alt text that occupy their own paragraph open through an image click or corner button; linked, inline, decorative, and `data-no-zoom` images retain their existing interaction. Image alt text names the modal, and the scale button returns to centered natural size (100%) while its accessible name also includes the current scale; keyboard focus cycles through six buttons in image views.

The viewer copies the SVG into a shadow root. Mermaid's embedded selectors and fragment IDs stay local to the copy, so its markers and styles cannot resolve against the original diagram. Panzoom transforms a viewport-sized canvas containing the SVG at its natural viewBox dimensions, so pointer coordinates and the transform origin share the same center; the initial scale and every resize fit the entire diagram without enlarging it beyond its natural size. This preserves vector detail while keeping fit independent of the narrow document column. The canvas has no visible frame; reserved space keeps controls clear of the fitted diagram.

Viewer resources belong to the mounted theme. Route, language, theme, and source-content replacement close the active view; asynchronous Mermaid renders and loaded images receive fresh entries. The body overflow lock relies on the default theme retaining visible overflow on the HTML element. It avoids mutating HTML attributes, which the Mermaid plugin observes and rerenders in response. The [shared modal](../../../../website/.vitepress/theme/media-viewer.ts), [Mermaid adapter](../../../../website/.vitepress/theme/mermaid-viewer.ts), and [image adapter](../../../../website/.vitepress/theme/image-viewer.ts) leave Markdown, raw page copies, and `llms.txt` generation with their existing owners.

## Alternatives considered

**Widening the document column.** A wider column cannot provide readable detail for arbitrarily large diagrams, and long diagrams still exceed the viewport.

**A custom overlay with document-wide listeners.** A native dialog already makes the background inert and handles modal dismissal. Theme-owned resources make navigation and teardown explicit; persistent document listeners would require a separate lifetime mechanism.

**A bitmap preview or a same-document SVG clone.** A bitmap loses vector detail at high zoom. A same-document clone duplicates Mermaid's IDs and embedded styles; rewriting all SVG and CSS references would add a parser obligation that a shadow root avoids.

## Consequences

The website gains Panzoom as a direct dependency and uses native dialog, shadow-root, and resize-observer support. Viewer zoom and position are transient: resizing refits the content, and navigating or changing the theme closes it. Existing page images and diagrams remain the reading and link-navigation source.

The [Mermaid tests](../../../../website/tests/mermaid-viewer.spec.ts) and [image tests](../../../../website/tests/image-viewer.spec.ts) run in the root unit-test suite; `docs:check` and `doc-sync` also select them so documentation-only validation exercises the viewer. They cover late rendering and loading, accessible names, initial and resized fit, the 100% action, keyboard cycling, switching between images and diagrams, source replacement, and resource release.

**CI coverage gap.** The DOM tests mock Panzoom and do not execute browser layout. Native modal behavior, SVG markers, pointer-anchored wheel zoom, canvas dragging, theme colors, and narrow-screen geometry require real-browser verification. The recorded browser demonstration supplies evidence for the current implementation, but it is not an automated regression check.
