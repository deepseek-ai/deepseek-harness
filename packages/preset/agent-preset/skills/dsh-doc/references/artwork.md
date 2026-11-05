# Plugin artwork

Draw an icon that is recognizable at row size and belongs beside the icons of installed DSH plugins, and, when it helps, a feature image for the detail document. The display checklist in `references/host-plugin.md` owns manifest exports, accepted formats, size limits, and installed-display checks.

## Establish the subject

- Inspect the feature, its output, and its manifest before drawing. A badge-producing skill may need a tag, not a medal. Reuse assets the user supplies; do not invent a brand mark for a third-party product or copy one whose license does not permit redistribution.
- Read the icons of two or three installed plugins with related purposes. `references/locate-docs.md` finds each package directory; for a package-root plugin, a top-level `package.json` `icon`, else its `./icon` export, names the file; a subpath plugin uses only `./<subpath>/icon`. Plugins that Plugin Manager draws itself have no icon file. Borrow one coherent treatment, not every reference's effects.
- Plugin Manager resolves the icon and display metadata separately for the bundle package and for each plugin its patch inserts; a subpath plugin or another package does not inherit the bundle's icon. Update every one you intend to change, and only those.

## Draw and refine

1. **Start simple.** Use one dominant subject and only the detail needed to explain it. Related capabilities can share a subject; distinguish them through proportions, silhouette, or palette rather than extra panels, symbols, or badges.
2. **Judge optical size.** Use `width="36" height="36" viewBox="0 0 36 36"`. Center the artwork with deliberate margins; 18–22 units is a useful starting extent, not a requirement for every silhouette or wide text tag. Plugin Manager chooses display sizes and draws the surrounding tile, so do not draw a tile or background in the SVG or enlarge a toolbar glyph to fill it.
3. **Keep geometry consistent.** Balance the main subject and secondary element. Align repeated marks and corners; keep tails and handles intentional. Refine one requested dimension at a time without changing approved parts.
4. **Use restrained color.** Match the saturation and brightness of neighboring installed icons. Reserve unusually vivid, bright, or neon colors for brand requirements, essential contrast, or explicit user direction. Tune saturation separately from hue and lightness; do not make artwork gray or muddy merely to reduce saturation. Keep flat fills or short gradients and limited layering; avoid glow, drop shadows, glossy highlights, and emoji.
5. **Align lettering by visible ink.** Use consistent letterforms, cap height, baseline, weight, and spacing. Compare rendered stroke edges, not just path coordinates: stroke caps and joins can make equal coordinates appear unequal. Draw lettering as paths and keep it readable at actual size.
6. **Make empty areas genuinely transparent.** A hollow lens must reveal the background, including where it overlaps another shape. Remove the underlying fill with a local mask or cutout; do not substitute a white or dark disk. Check both themes.

## Export

- Plugin Manager loads icons as images; an image that cannot decode falls back to the panel's default artwork. Export self-contained SVG geometry with local, uniquely named gradient, mask, and clip references. For these icons, omit scripts, event handlers, `<style>`, animation, `<image>`, and `foreignObject` to keep the asset self-contained. Draw lettering as paths rather than `<text>` so browser font substitution cannot change it.
- Do not change assets the feature itself produces merely to change its icon.

## Feature image

A detail document may start with one feature image when a picture shows the result better than text. Draw it only when the user asks for one or the result cannot be shown in text, after the plugin works. Save one SVG per document language, such as `docs/preview.svg` and `docs/preview.zh.svg`, with `width="640" height="300" viewBox="0 0 640 300"`, and reference it from the first line of that document as `![Short description](preview.svg)`, and `preview.zh.svg` from `DETAIL.zh.md`. Images must fit `pluginManager.detailImageMaxBytes` (5 MiB by default). Show one main example of the real interface or result, optionally with one close-up, using the plugin's exact UI labels; keep important content about 32 units from the edges. The export rules above apply, so outline every word into paths. Check that it stays readable at its displayed width in light and dark themes.

## Review

1. Deliver the plugin with one icon first. Show a few numbered SVG alternatives only when the user asks for alternatives or refinement; keep their numbers through review and apply the chosen one. Write alternatives outside the bundle directory.
2. Compare the new icon, and the old one when revising, beside unchanged installed icons in light and dark themes, at actual row and card sizes as well as enlarged. Check balance, lettering, empty space, clipping, and that the image decodes. Without browser control, report that rendered display remains unverified.
3. After installation, verify the rendered icon in every affected bundle and plugin row through the display checklist.
