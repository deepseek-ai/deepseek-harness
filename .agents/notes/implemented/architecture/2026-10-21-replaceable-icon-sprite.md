# Agent Note: Replaceable product icons through an SVG sprite

Status: implemented

English | [中文](2026-10-21-replaceable-icon-sprite.zh.md)

## Problem

Long-term skin customization needs themes to replace icons, not only colors. Product icons were React components that drew inline SVG paths, so a theme registered through `ctx.theme` could recolor them through `currentColor` but could not change their artwork. About 150 Client files import these components.

## Decision

Each product glyph weight is one sprite symbol, `dsw-icon-<glyph>-<weight>`. ui-primitives keeps the default SVG documents as `ICON_SYMBOLS`; an icon component keeps its export name, `size`, and `className`, and renders an `<svg>` box with one `<use>` of its symbol. ui-theme keeps one hidden sprite in the document whose `<symbol>` children come from the active theme's `ThemeDefinition.icons` replacements or the defaults. Artwork reached through `<use>` inherits `currentColor` and CSS custom properties from the use site, so a replacement can be multi-color, can paint with `--dsw-*` color tokens, and follows light and dark palettes without separate values.

## Alternatives considered

- **Icons as CSS image tokens painted through `mask-image`.** Rejected after design review: a mask keeps only the image's alpha, so every icon stays one color, and a `url()` image cannot read CSS variables, so multi-color artwork could not follow color tokens. It would have reused the token override layer without a new theme field.
- **A runtime icon registry service with React components as values.** Rejected: components cannot read services or React context, so every icon import site would need a new prop or slot.
- **A slot per icon.** Rejected for the same caller cost; slots carry composition, not artwork.

## Consequences

- Icon DOM contains a `<use>` reference instead of paths; tests identify glyphs through `data-icon` and inspect artwork through `ICON_SYMBOLS`.
- Without ui-theme, the sprite is absent and icons render nothing.
- Every symbol shares the document id space, so `register` requires element ids inside a replacement to start with `<symbol id>-`; `<use>` in another document, such as an iframe, cannot reach the sprite.
- Replacement markup is trusted like the registering plugin's code; `register` rejects `<style>` and `<script>` only because they would apply to the whole document.
- Gradients and other paint servers resolve their stops where the sprite sits, so they follow palette tokens but not use-site color overrides.
- Default and token-colored replacement symbols render pixel-identically through `<use>` and inline in Chromium, WebKit, and Firefox.
- File-type, plugin, site, and brand artwork still render inline and are not replaceable yet.
