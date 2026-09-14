# Agent Note: Shared file-type icons

Status: implemented

English | [中文](2026-09-08-shared-file-type-icons.zh.md)

## Problem

Client feature plugins can share React components only through `@deepseek-ai/dsh-client-ui-primitives`, but file cards had no shared file-type presentation. `LinkIcon` owned the only extension table and deliberately collapsed paths into six link categories, while attachment cards, sent-message attachments, queued files, and workspace file rows used one generic document glyph. Two of those consumers also carried separate extension-display helpers. Adding a precise file icon anywhere else would have required another extension table or a runtime import between feature plugins.

## Decision

`ui-primitives` owns one Cordis-free file classification and rendering API. `fileExtension(path)` applies the shared basename and final-dot semantics to either path separator. `classifyFileType(path)` matches without case sensitivity and returns the closed `FileType` union: the traditional `code`, `excel`, `folder`, `html`, `image`, `markdown`, `other`, `pdf`, `ppt`, `video`, and `word` categories plus the detailed `CodeFileType` categories rendered by `CodeFileIcon`. Exact filenames, filename prefixes, filename suffixes, optional project context, and extensions run in that order. The path classifier returns every member except `folder`; callers use the explicit `FileTypeIcon` `kind` override when they know an entry is a directory. Unknown extensions, missing extensions, and trailing dots resolve to `other`, except the shared table recognizes named files such as `Dockerfile`, `Makefile`, `package.json`, `.gitignore`, `README`, and `CHANGELOG`.

`FileTypeIcon` accepts a path, shared `IconProps`, the explicit `kind`, and an optional project-file snapshot. Traditional file types render the supplied 28px document and folder contours as inline SVG. Excel, Markdown, PDF, PPT, and Word foreground marks scale to 122% around their visual center; the remaining marked traditional glyphs use 112%, while the file body and folded corner retain their source geometry and the generic file has no invented center mark. The sheet is a solid category color, the foreground mark and ordinary folded corner are white, and the generic file has a darker grey corner. CSS assigns the supplied category palette through static design tokens: DeepSeek blue for code/HTML/Markdown, the lighter DeepSeek blue for Word, green for Excel, two amber steps for folder/PPT, red for PDF, and neutral grey for unknown files. Image and video share the supplied violet through a component-local variable because the design platform has no matching violet token. A caller may override a traditional sheet through `--dsh-file-type-icon-color`.

Recognized code and configuration files render the corresponding 20px square artwork scaled to the requested icon size. The embedded static table contains exactly the 48 established `CodeFileType` entries; archive-only artwork does not add a category, and an adjacent manifest records the responsible design owner and source digests. Tests reject scripts, event attributes, external references, and duplicate ids in that table. `CodeFileIcon` replaces local SVG ids with a per-component prefix before insertion so repeated gradients and clip paths remain independent. These technology marks retain their embedded multicolor fills and are the explicit exception to the ordinary current-color icon rule. The map selects React before TypeScript/JavaScript, Angular filename suffixes before their base extension, Docker/Node/Git/Make/CMake by filename rules, and Flutter only when the optional project snapshot contains a `pubspec.yaml` whose text includes `flutter:`. Markdown and SVG remain owned by the traditional Markdown and image categories. CSV and TSV use the code glyph in file cards, rows, and preview titles; their clickable links also use code. Both `.env` and names ending in `.env` use the environment glyph. Every traditional and technology SVG is `aria-hidden`, and the card, row, or button that owns the file identity supplies the accessible name.

`LinkIcon` delegates extension classification to `classifyFileType` and folds the detailed result into its existing link vocabulary: code and HTML use `code`, images use `image`, PDF/Word/Excel/PPT use `document`, and Markdown/video/unknown files use `other`. Extensionless names remain `other` in link contexts, so the 14px clickable-link appearance defined by the [clickable-link decision](2026-09-04-web-clickable-link-styles.md) does not change.

Attachment upload cards, sent-message file cards, queued-file rows, and workspace file rows render `FileTypeIcon`. The Files tab title renders its explicit `folder` kind at 16px. Explicit delivery cards use `FileTypeIcon` at 20px and `fileExtension` for their fallback metadata. The two metadata rows use `fileExtension` rather than local parsers; a leading-dot basename such as `.env` therefore displays `ENV`, while an absent or trailing suffix displays no extension label. Image content continues to render as a preview rather than a file-type glyph, and produced-file links and Markdown file mentions continue to use `LinkIcon` because they are link surfaces.

## Alternatives considered

**Use `LinkIcon` for every file surface.** Rejected. Its six categories and 14px outline drawings communicate link destinations at text size; a 28px file card has room for the supplied HTML, Markdown, PDF, Word, Excel, PPT, and video identities.

**Keep a second extension table beside `LinkIcon`.** Rejected. The same path could drift to different categories as either list grows. One detailed table plus an explicit detailed-to-link adapter preserves both consumers' semantics.

**Put the supplied traditional-file colors directly in each SVG path.** Rejected. Traditional SVG geometry stays reusable and follows the icon set's `currentColor` rule; the component stylesheet owns the default category palette, and render sites retain one CSS-variable override instead of rewriting path fills. The technology artwork is exempt because its embedded multicolor marks identify the language or tool rather than decorating a generic file silhouette.

**Add archive, audio, and data categories for symmetry.** Rejected. The supplied artwork and current consumers require no such glyphs. New `FileType` members require a shipped render site and artwork that remains legible at the 28px seat.

## Testing

The `ui-primitives` specs cover case-insensitive suffixes, both path separators, leading-dot files, missing and trailing suffixes, common named files, unknown fallback, all detailed code mappings, rule priority, Flutter context, the exact 48-key artwork set, rejected archive-only categories, static-markup safety, instance-safe SVG ids and references, `aria-hidden`, sizing/class forwarding, distinct artwork, the 112% and 122% foreground-mark transforms, and the traditional solid-sheet/contrast-mark layers without literal SVG colors. A stylesheet spec pins every traditional category-to-color mapping, the caller override, and the local violet value. The existing `LinkIcon` classification table pins its coarse output, including `Makefile` remaining `other`. Attachment, chat, queue, and sidebar component suites exercise the migrated render paths; their accessibility output does not change because the glyphs remain decorative.

## Consequences

- Client packages use one filename parser and one detailed file-type table instead of importing or recreating feature-local logic.
- A new suffix joins the detailed table only when an existing glyph truthfully represents it. If its link category differs from the current adapter, the change must also decide whether the 14px link appearance changes.
- Code and configuration artwork preserves its embedded palette and does not accept the traditional `--dsh-file-type-icon-color` override.
- The fixed 48-entry artwork table adds about 35 kB uncompressed and 17 kB gzip to the shared browser bundle; adding categories must justify that static baseline cost.
- The primitive owns no copy but does own the default file-type palette. Consumers continue to own accessible labels and surrounding text, and may replace the category color through `--dsh-file-type-icon-color`.
- The detailed category names describe presentation, not MIME validation. A suffix is a display hint and does not establish file contents or trust.
