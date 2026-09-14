---
description: "Shared React UI atoms for the dsh web client: controls, icons, markdown and math rendering, and the terminal/read/diff/search/web output cards (zero Cordis)."
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-primitives

English | [中文](README.zh.md)

## Summary

Use `dsh-client-ui-primitives` to build web-client controls and render agent output with shared React UI. It includes standard controls, icons, anchored overlays, and renderers for Markdown with TeX, terminal output, file reads, diffs, search, web retrieval, and JSON. The renderers handle untrusted model output by dropping raw HTML, restricting links, and parsing ANSI escape sequences. The components import no Cordis runtime; callers supply localized labels, and theme-facing colors use `--dsw-*` design tokens.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package is a Web-shell build input. Its static ESM retains third-party imports and styles for Vite; independent consumers supply its development dependencies ([dependency rules](../AGENTS.md#dependency-declaration)).

Compose feature UI from these atoms whenever the web client needs a standard control or an agent-output renderer. They render through React only and take `--dsw-*` design tokens from the theme, so they fit any plugin without importing the theme or the slot system.

<a id="component-catalog"></a>
### Component catalog

Check this table before writing a control in a feature package. A plugin cannot import another plugin's component, so this package is the only place a control can be shared: reuse what fits, and lift a deliberate visual difference into a prop rather than starting a second copy.

| Export | What it is |
|---|---|
| `Button` | Clickable action; `variant` selects `primary`, `ghost`, `outline`, or `toolbar`. |
| `Switch` | Two-state toggle, 36×20. `label` is required, so the control cannot ship unnamed. |
| `Input` | Single-line text entry for search boxes and inline forms. |
| `Menu` | Dropdown of items, separators, and group labels, with nested submenus. |
| `Pill` | Selectable capsule button for view switchers and filters; takes `active` and `onClick`. |
| `Tag` | Read-only capsule badge; `tone` selects one of eight palettes. |
| `StateDot` | Status mark: `done`, `warning`, `ongoing`, `error`, or `idle`. `aria-hidden`, so the render site owns the name. |
| `ConnectionIndicator` | Inline connection-recovery control across outage, retry, and recovered states. |
| `DisclosureRow` | 24px compact disclosure that lays title and content side by side. |
| `Modal` | Centered dialog over a page mask. |
| `RiskConfirmation` | Sensitive action gated behind an explicit checkbox. |
| `OnboardingSurface` | First-run stage that holds the application root inert. |
| `Tooltip` | Hover text on a cloned anchor, placed right, bottom, or top. |
| `HoverCard` | Hover preview the pointer can rest on and select from; optional copy button. |
| `Toast` | Transient top-center banner held for the owner's `holdMs`. |
| `JsonTree`, `JsonBlock` | Read-only JSON inspection. |
| `MarkdownText`, `CodeBlock` | Untrusted GFM with TeX math, and highlighted code. `CodeBlock` accepts opt-in `lineNumbers`; copied source excludes the gutter, and `contentRef` exposes its stable source wrapper to an owner that uses it as a scrollport. Set `showHeader={false}` when the owner supplies its own language and copy toolbar. |
| `TerminalBlock`, `ReadBlock`, `DiffBlock`, `SearchBlock`, `WebBlock` | The agent-output card matching each tool-result intent. |
| `icons/*`, `FishLogo`, `BrandWordmark`, `ReferenceIcon`, `LinkIcon` | Glyphs and brand marks. Use `LinkIcon` for 14px clickable-link categories. |
| `FileTypeIcon`, `classifyFileType`, `fileExtension` | A category-colored 28px file or folder glyph and the shared case-insensitive filename mapping behind it. Code and configuration files use detailed full-color technology glyphs; use `LinkIcon` for link-leading glyphs and image previews for image content. |

Three pairs are easy to confuse:

- **`Tag` against `Pill`.** Reach for `Tag` for a read-only badge at the 11px capsule size, and for `Pill` when the capsule is selectable (`active` and `onClick`, as view switchers and filters use) or when it must sit on a 24px text line — `TerminalBlock` renders its exit status as a static `Pill` for exactly that reason. Size decides as much as interactivity here; the two are not interchangeable.
- **`DisclosureRow` against a card.** The row lays its title and content side by side at a fixed 24px. A card that stacks a name over a description is a different layout, and belongs in the feature package — `ui-settings-plugins`' `PluginCard` is the precedent and records why.
- **`FoldToggle` against the exported surface.** It is package-internal and not exported; the output cards use it for their head-tail fold.

Writing your own component in your own package is fine when the need is genuinely specific. What is not fine is copying a control that already exists here — and once a second package needs the same control, it belongs in this package ([decision](../../../.agents/notes/implemented/architecture/2026-09-05-shared-client-control-primitives.md)).

### Controls and icons

The catalog above lists what each export is for; this section covers the behavior that props alone do not show. The `ic_ds_*` icon set and `FishLogo`/`BrandWordmark` marks fill brand and inline-icon slots. `FileTypeIcon` renders the traditional 28px Excel, folder, HTML, image, Markdown, generic, PDF, PPT, video, and Word glyphs, and uses the imported square technology artwork for the established 48 code and configuration categories. The import replaces artwork only: archive-only categories do not extend `CodeFileType`. `classifyFileType` applies exact filename, prefix, suffix, optional project-context, and extension rules in that order; React names win over TypeScript/JavaScript, Angular suffixes win over their base extension, and a Dart file becomes Flutter only when the supplied project files contain a `pubspec.yaml` with `flutter:`. Markdown and SVG remain traditional Markdown and image files. Office mappings include XLSM/Numbers as Excel, KEY as slides, and RTF/ODT/Pages as documents. `fileExtension` exposes the same basename and final-dot parsing for adjacent metadata labels. Traditional glyphs use a solid category-colored sheet with a white mark and translucent white corner; the generic file uses a grey sheet and darker grey corner. Callers may override the sheet color through `--dsh-file-type-icon-color`. The full-color technology artwork is the deliberate exception and retains its embedded palette. All glyphs are decorative and carry no label. `LinkIcon` remains the smaller leading glyph for clickable artifact links — globe, folder, code, image, document, or plain paper — while `classifyLinkPath` folds the shared file types into that existing six-category vocabulary. `ConnectionIndicator` renders a warning-colored disconnected action whose permanent retry glyph marks the retry action beside the owner-supplied outage label, a connecting spinner beside a label whose one-to-three dots advance every 500ms independently of retry timing, or a success-colored recovered status. Clicking either warning state requests an immediate reconnect; no hover interaction changes the copy. The pill fades in on appearance, fades out for 150ms before unmounting, and sizes to its current label. Its owner supplies visibility, the recovery hold, localized labels, and the immediate-reconnect callback; the primitive uses no native title tooltip. `useAnchoredPosition` and `useAnchoredMaxHeight` keep floating panels and bottom-anchored overlays clamped to the viewport and following their anchor. `HoverCard` keeps its portaled preview reachable across the anchor gap and can expose a copy button through the `copyText` prop. `Toast` holds for the window its owner names through `holdMs`, because how long a banner has to stay depends on how much there is to read; the same value drives its unmount timer and the stylesheet's fade delay, so the two cannot disagree. `rankByName` is the `/` menu's shared candidate ranker for the command and skill sources: the query must be a case-insensitive ordered subsequence of the name; prefix hits rank first, then alignment score, then source order. `Menu.autoFocus` focuses its first enabled item, supports Arrow Up/Down and Home/End navigation, and focuses the first button in the anchor on Escape; it is opt-in for action menus.

### Rendering agent output

`MarkdownText` renders untrusted GFM and TeX math, blocks unsafe links and images, and can turn resolved file mentions into explicit controls. When the owner passes a `pathImages` vocabulary, image destinations that are local media paths rewrite to displayable URLs on settled renders only (the same streaming gate as file mentions); without a vocabulary, local destinations remain inert alt text. A load or decode failure replaces the image with its authored alt text, or the original destination when alt is empty. Changing the image source permits a fresh load. While a reply streams, it freezes completed blocks, advances a top-level open fence by completed lines, and highlights that fence from saved Shiki grammar state. Completed token lines enter fixed-size React groups, so later chunks reconcile only the growing group; an unchanged fence retains that DOM when the final full parse resolves cross-document syntax. `TerminalBlock`, `ReadBlock`, `DiffBlock`, `SearchBlock`, and `WebBlock` render the matching tool-result intent with copy controls, overflow handling, and ANSI processing where applicable. `JsonTree` and `JsonBlock` inspect JSON values read-only, while `projectUserText` projects sent user text into inline plain runs and reference chips for the message bubble and queue rows. When supplied with `UserTextReferences`, file and skill references become keyboard-accessible preview buttons using the same hover and focus styling as prose file links; the first pointer click can open a preview, while subsequent clicks and existing text selections retain native selection handling. Keyboard activation opens previews even when text is selected.

`DiffBlock` compares the old and new content by line. It shows actual additions and deletions with up to three neutral context lines on each side, separates distant changes with `⋯`, and excludes shared context from both summary and footer totals. Search stops beyond 256 line additions/deletions per fragment; those fragments display and count the complete old and new contents as a coarse replacement, including shared lines. Copy includes the full displayed diff with its prefixes. A final newline is treated as a terminator; differences only in the presence of a final newline are not displayed.

`JsonTree` clamps collapsed strings to `collapsedStringLines` (three by default). Expanded strings show raw text, retain sibling commas, and fit within the window and outer scrolling containers. Resize and ancestor-scroll events update that limit. Row copy feedback updates independently of JSON value rendering; pending clipboard writes cannot update a different row or an unmounted tree.

### Localizing copy

The atoms cannot read the application locale, so every piece of user-facing copy arrives through required label props. `HoverCard`, `TerminalBlock`, `JsonTree`, `CodeBlock`, `MarkdownText`, `JsonBlock`, `ConnectionIndicator`, `Modal`, `DiffBlock`, `ReadBlock`, `SearchBlock`, and `WebBlock` accept complete localized labels. The package owns no language fallback; omission fails typechecking, and each feature maps its typed `t` seat into the primitive's label interface.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package enforces one separation: presentational React atoms with zero Cordis and zero slot knowledge, styled only through `--dsw-*` tokens, while every feature-specific concern (locale, session data, composition) stays in the composing plugin.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Public atom exports |
| [`src/markdown/`](src/markdown/) | Markdown and math pipeline: micromark parsing, KaTeX typesetting, incremental streaming renderer, `CodeBlock`/`JsonBlock` |
| [`src/TerminalBlock.tsx`](src/TerminalBlock.tsx) | ANSI escape parsing (`anser`) and terminal card rendering |
| [`src/ReadBlock.tsx`](src/ReadBlock.tsx) / [`src/DiffBlock.tsx`](src/DiffBlock.tsx) | Read and diff cards |
| [`src/SearchBlock.tsx`](src/SearchBlock.tsx) / [`src/WebBlock.tsx`](src/WebBlock.tsx) | Search and web-retrieval cards |
| [`src/icons/`](src/icons/) | `ic_ds_*` glyph components and brand marks |
| [`src/useAnchoredPosition.ts`](src/useAnchoredPosition.ts) / [`src/useAnchoredMaxHeight.ts`](src/useAnchoredMaxHeight.ts) | Floating-panel and overlay geometry hooks |

### Streaming markdown

While a reply streams, `MarkdownText` parses incrementally: all but the trailing two blocks freeze as cached React elements and only the source tail re-parses per chunk, so per-chunk work tracks the tail instead of the whole reply. A final unclosed top-level fence keeps its parsed code node and sends only the last completed line plus the current partial line through the same GFM grammar; a closing fence or ambiguous parse returns to the ordinary tail path. Highlighting likewise resumes from saved Shiki grammar state and publishes only newly completed lines plus the mutable tail. `CodeBlock` seals completed lines into fixed-size React groups, reuses earlier groups, and retains the whole highlighted tree across settlement when code and language are unchanged. The settled full parse still resolves references that crossed the freeze boundary.

### Geometry and overflow

The output cards share one geometry model: `white-space: pre` with horizontal scrolling so column-aligned content keeps its alignment, and a head-plus-tail slice behind an expand button past `maxLines` (default 16) so a long body never stretches the card. `TerminalBlock` parses ANSI into React spans with a per-line column buffer for cursor movement, honoring erase-in-line, tab stops, and character width.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages place the atoms in the client stack and the design system.

- [ui-renderer](../ui-renderer/README.md) — the React renderer that mounts the assembled application and binds slot data.
- [ui-tool](../ui-tool/README.md) — the tool-call presentation layer that composes these output cards.
- [ui-conversation](../ui-conversation/README.md) — the chat surface that renders markdown replies and tool cards.
- [ui-theme](../ui-theme/README.md) — the `--dsw-*` token system these atoms style through.
- [Web styling](../../../docs/web-styling.md) — the authoritative styling rules for web client components.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how the atoms behave at the edges; they are current package constraints, not a component roadmap.

- **Diff search is bounded, input processing is linear** — the edit-distance limit trades precise alignment for a coarse replacement on heavily changed fragments. Normalization, fallback rows, and copied output still scale with input size; the height cap limits visible rows, not those allocations.
- **Streaming defers cross-boundary reference resolution** — a reference-style link or footnote whose definition sits on the other side of the incremental freeze boundary renders as literal text while the reply streams; the settled full parse at finalize resolves it.
- **A long highlighted fence retains its complete token DOM** — streaming avoids re-parsing, re-tokenizing, and reconciling the completed prefix, but it does not discard old colors or virtualize token spans. Final DOM cardinality therefore still follows the fence's token count; nested/container fences and a pathological single long line remain on the general tail path.
- **Glyph-level icons are redrawn approximations** — the fish logo and the sparkle mark come from font glyphs whose vector geometry is not exportable from the local design data; hand-authored recreations stand in until an exact export path exists.
- **`Pill` and `Input` have no design source** — both atoms are self-defined; the sidebar search field and view-tab strip that resemble them are consumer-owned compositions, not these atoms.
- **No `Active` `StateDot` variant** — the supported states are done, warning, ongoing, error, and idle.
- **User-facing copy is required at the render site** — the atoms are zero-Cordis and cannot reach `ctx.locale`; each feature must supply complete localized labels through the primitive's typed props ([decision](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md)).
- **`TerminalBlock` is not a terminal emulator** — it renders settled or still-running command output, not an interactive session: SGR colors, carriage return, backspace, erase-in-line, tab stops, and character width are honored; absolute cursor positioning, screen clearing, and alternate-screen sequences are stripped.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Pure props-in React atoms with no Cordis API — no events, no services, no mutable cross-plugin state; rendering contracts are asserted directly by this package's component specs.
