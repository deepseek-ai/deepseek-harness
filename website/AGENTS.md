# AGENTS.md — Documentation website adapter

Follow the [root instructions](../AGENTS.md), the [documentation standard](../docs/AGENTS.md), and the [documentation workflow](../.agents/skills/dsh-doc/SKILL.md).

## Keep documentation content out of this tree

`website/` owns only VitePress configuration, presentation assets, and the publication manifest. This file is the only maintained Markdown file in this subtree.

Keep canonical prose and generated catalogs in their owning `docs/` tier, then expose selected pages through [docs.ts](docs.ts). Never add locale, route, API, or copied documentation trees such as `website/zh-CN/`, `website/en/`, or `website/api/`.

The projector writes disposable Markdown to the ignored `website/.generated/` directory. Never edit or commit `.generated/`, `.cache/`, or `.dist/`.

Production builds remove the configured output directory after VitePress resolves the site configuration and before it writes files. They reject output whose lexical path or nearest existing parent escapes the real site root, and unlink a link-shaped output instead of traversing its target. Raw-Markdown emission then treats files produced by that build as occupied and never overwrites them.

The build also emits each route's raw-Markdown twin (with a parent-level alias per index route) and a root `llms.txt` index into `.dist/`, so a page's URL, minus any trailing slash, plus `.md` serves it as plain Markdown. Both derive from the publication manifest at build time; neither is ever a file in this tree.

Run `pnpm docs:check` after changing this subtree; the gate rejects additional non-ignored Markdown under `website/`.

Content-page Markdown actions use the projector's `rawMarkdownPath` and the site base, including full `index.md` routes. Copy fetches carry `?dsh-raw=1`; development script imports still belong to Vite. Keep clipboard work within its initiating gesture and page lifetime; the [Markdown actions decision](../.agents/notes/implemented/feature/2026-09-15-docs-page-markdown-actions.md) owns browser limitations and verification.

The default-theme extension shares one fullscreen modal and pan/zoom controller between Mermaid diagrams and standalone content images. Keep enhancements separate from Markdown projection and preserve source elements. Images must be loaded, have nonempty alt text, and occupy their own paragraph; linked, inline, decorative, and `data-no-zoom` images keep their existing interaction. Image views expose intrinsic size through the 100% control. Route, language, theme, and source replacement changes close the active view; theme disposal releases every observer, listener, and scroll lock. The [viewer decision](../.agents/notes/implemented/feature/2026-09-14-docs-mermaid-viewer.md) explains SVG isolation and verification.

Native code groups keep their radio controls in separate forms so copied search excerpts cannot clear the page's selected platform. Search excerpts and MPA builds display every command block because tab switching is unavailable; the [platform-tab decision](../.agents/notes/implemented/feature/2026-09-15-docs-platform-command-tabs.md) owns the interaction and verification.
