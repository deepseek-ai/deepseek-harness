---
name: dsh-official-plugin-artwork
description: Draw and review official DeepSeek Harness plugin icons, including experimental plugins. Use for package icon.svg assets and PluginArtwork glyphs; covers semantic references, proportions, lettering, transparency, package metadata, and designer review. Not for toolbar or action icons.
---

# Official plugin artwork

Draw recognizable artwork that belongs beside the existing official icons. Official and official experimental plugins share this visual language; the UI label communicates experimental status. This guidance does not replace designer approval.

## Establish the subject

- Inspect the actual feature, its output, and its owning manifest before drawing. A badge-producing skill may need a tag, not a medal. Reuse designer-supplied assets; do not invent a brand mark or change product names, identifiers, or unrelated icons without approval.
- Read the [existing artwork](../../../packages/client/ui-primitives/src/plugin-artwork.tsx) and the nearest relevant package SVGs. Borrow one coherent treatment, not every reference's effects. Action icons remain with [dsh-client-ui-ux](../dsh-client-ui-ux/SKILL.md#reuse-before-adding).
- Check every affected entry, list, detail, and component row. Bundle artwork and a component's name and icon can have separate metadata owners; changing one does not update the other.

## Draw and refine

1. **Start simple.** Use one dominant subject and only the detail needed to explain it. Related capabilities can share a metaphor; distinguish them through proportions, silhouette, or palette rather than extra panels, symbols, or badges.
2. **Judge optical size.** Use `width="36" height="36" viewBox="0 0 36 36"`. Center the artwork with deliberate margins; 18–22 units is a useful starting extent, not a requirement for every silhouette or wide text tag. The [page renderer](../../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx) owns display sizes and outer tile framing. Do not bake that tile into the SVG or enlarge a toolbar glyph to fill it.
3. **Keep geometry consistent.** Balance the main subject and secondary element. Align repeated marks and corners; keep tails and handles intentional. Refine one requested dimension at a time without changing approved parts.
4. **Use restrained color by default.** Balance saturation and brightness with neighboring icons; prefer existing palettes such as [Auto Authorization Review](../../../packages/experimental/auto-review/icon.svg) and [Codex subagent](../../../packages/subagent/subagent-codex/icon.svg). Reserve unusually vivid, bright, or neon colors for approved brand requirements, essential contrast, or explicit designer direction. Tune saturation separately from hue and lightness; do not make artwork gray or muddy merely to reduce saturation. Keep flat fills or short gradients and limited layering; avoid glow, drop shadows, glossy highlights, and emoji. Page CSS still uses semantic theme tokens.
5. **Align lettering by visible ink.** Use consistent letterforms, cap height, baseline, weight, and spacing. Compare rendered stroke edges, not just path coordinates: stroke caps and joins can make equal coordinates appear unequal. Export lettering as paths without a font dependency, and keep it readable at actual size.
6. **Make empty areas genuinely transparent.** A hollow lens must reveal the background, including where it overlaps another shape. Remove the underlying fill with a local mask or cutout; do not substitute a white or dark disk. Check both themes.

## Export at the owner

- Use the manifest's `icon` path and publish its resources. Update intentional bundle/component copies together; verify localized display names and descriptions when those are in scope. Do not change the feature's produced assets merely to change its plugin icon.
- Package images render through `<img>`: export self-contained SVG geometry with local, uniquely named gradient, mask, and clip references. No scripts, event handlers, animation, external images/styles, fonts, or `foreignObject`. Inline React artwork needs per-instance IDs; separate image documents do not share IDs.
- Keep the asset change local. Do not add runtime dependencies, primitive exports, or renderer special cases just to display it.

## Review and verify

1. Show a few numbered alternatives before polishing uncertain geometry. Preserve their labels through review and apply the chosen version; an existing file or generated draft does not establish designer approval. Keep comparison artifacts in a gitignored directory, not the product package.
2. Compare old and new artwork beside unchanged references in light and dark themes, at actual row/card sizes as well as enlarged. Check balance, lettering, empty space, clipping, and image decoding.
3. Run `pnpm run verify-package-meta` for [package metadata and SVG artwork](../../../scripts/verify-package-meta.ts), `pnpm run constraints` for the canonical package payload, and `pnpm run verify-official-bundle-catalog`. Regenerate a stale catalog with `pnpm run gen-official-bundle-catalog`, never by hand. Structural checks do not replace visual review.
4. Build affected artifacts and inspect the real page through `dsh web`. Batch approved refinements before restarting a metadata-caching Host, then verify the entry and nested component rows in both themes.
5. Follow the repository's UI testing policy and [record-browser-gif](../record-browser-gif/SKILL.md) for a GUI PR. Obtain designer approval before landing new glyphs. Record reusable drawing principles here, not the history of rejected drafts.
