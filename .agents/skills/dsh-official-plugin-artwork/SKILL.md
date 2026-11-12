---
name: dsh-official-plugin-artwork
description: Draw and review official DeepSeek Harness plugin icons and optional feature previews, including experimental plugins. Use for package artwork and PluginArtwork glyphs; covers official references and palettes, feature previews, package metadata gates, and designer review, and links the shared drawing rules that the `dsh-doc` skill ships. Not for toolbar or action icons.
---

# Official plugin artwork

Read and follow [plugin artwork](../../../packages/preset/agent-preset/skills/dsh-doc/references/artwork.md) first; installed DSH ships it in the `dsh-doc` skill, and it owns the subject, drawing, and export rules. Its Review section describes Creator bundles installed through Plugin Manager; for official plugins, follow its comparison step and replace its other steps with [Review and verify](#review-and-verify) below. Official and official experimental plugins share one visual language; the UI label communicates experimental status. This guidance does not replace designer approval.

When reviewing the containing page, use the [UI review baseline](../../../docs/ui-design-review-cases.md#review-baseline) to combine artwork balance with its tile, label, neighboring cards and theme material. Keep package artwork distinct from action icons: coherent optical weight does not require equal drawing bounds, monochrome fills or identical geometry across those roles.

## Optional feature previews

Before drawing a larger image for the top of an official bundle's detail document, read and follow [adding a plugin feature preview](../../../docs/cookbook/adding-a-plugin-preview.md). It owns optionality, image count, design canvas, position, language variants, file location, and acceptance. The guide also owns the embedded-raster exception for SVG previews; small icons remain geometry-only. The icon dimensions in plugin artwork do not apply to previews. Inspect the real feature and preserve its produced assets.

## Official references and owners

- Reuse designer-supplied assets. Do not invent a brand mark or change product names, identifiers, or unrelated icons without approval.
- Read the [existing artwork](../../../packages/client/ui-primitives/src/plugin-artwork.tsx) and the nearest relevant package SVGs. Prefer existing palettes such as [Auto Authorization Review](../../../packages/experimental/auto-review/icon.svg) and [Codex subagent](../../../packages/subagent/subagent-codex/icon.svg). The designer supplies explicit permission for vivid colors; brand requirements need approval. Use these references instead of installed-plugin discovery. Action icons remain with [the UI design entry](../dsh-client-ui-ux/SKILL.md#select-the-rule-owners).
- The [page renderer](../../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx) owns display sizes and outer tile framing. SVG artwork may use literal colors; page CSS uses semantic theme tokens.
- Check every affected entry, list, detail, and component row. Bundle artwork and component metadata have separate owners; update intentional copies together and verify localized display names and descriptions when those are in scope.
- Inline React artwork needs per-instance IDs; separate image documents do not share IDs.
- Keep the asset change local. Do not add runtime dependencies, primitive exports, or renderer special cases just to display it.

## Review and verify

1. Before polishing uncertain geometry, show a few numbered alternatives and keep their numbers through designer review. Apply the chosen one; existing files and generated drafts do not establish approval. Keep comparison artifacts in a gitignored directory, not the product package.
2. Run `pnpm run verify-package-meta` for [package metadata and SVG artwork](../../../scripts/verify-package-meta.ts), `pnpm run constraints` for the canonical package payload, and `pnpm run verify-official-bundle-catalog`. Regenerate a stale catalog with `pnpm run gen-official-bundle-catalog`, never by hand. Structural checks do not replace visual review.
3. Build affected artifacts and inspect the real page through `dsh web`. Batch approved refinements before restarting a metadata-caching Host, then verify the entry and nested component rows in both themes.
4. Follow the repository's UI testing policy and [record-browser-gif](../record-browser-gif/SKILL.md) for a GUI PR. Obtain designer approval before landing new glyphs. Record reusable drawing principles in [plugin artwork](../../../packages/preset/agent-preset/skills/dsh-doc/references/artwork.md), not the history of rejected drafts.
