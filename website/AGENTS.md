# AGENTS.md — Documentation website adapter

Follow the [root instructions](../AGENTS.md), the [documentation standard](../docs/AGENTS.md), and the [documentation workflow](../.agents/skills/dsh-doc/SKILL.md).

## Keep documentation content out of this tree

`website/` owns only VitePress configuration, presentation assets, and the publication manifest. This file is the only maintained Markdown file in this subtree.

Keep canonical prose and generated catalogs in their owning `docs/` tier, then expose selected pages through [docs.ts](docs.ts). Never add locale, route, API, or copied documentation trees such as `website/zh-CN/`, `website/en/`, or `website/api/`.

The projector writes disposable Markdown to the ignored `website/.generated/` directory. Never edit or commit `.generated/`, `.cache/`, or `.dist/`.

Production builds remove the configured output directory after VitePress resolves the site configuration and before it writes files. They reject output whose lexical path or nearest existing parent escapes the real site root, and unlink a link-shaped output instead of traversing its target. Raw-Markdown emission then treats files produced by that build as occupied and never overwrites them.

The build also emits each route's raw-Markdown twin (with a parent-level alias per index route) and a root `llms.txt` index into `.dist/`, so a page's URL, minus any trailing slash, plus `.md` serves it as plain Markdown. Both derive from the publication manifest at build time; neither is ever a file in this tree.

Run `pnpm docs:check` after changing this subtree; the gate rejects additional non-ignored Markdown under `website/`.

The default-theme extension owns the Mermaid fullscreen viewer. Keep its enhancements separate from Markdown projection and preserve the original SVG. Route, language, theme, and rendered-SVG changes close the active view; theme disposal releases every observer, listener, and scroll lock. The [viewer decision](../.agents/notes/implemented/feature/2026-09-14-docs-mermaid-viewer.md) explains SVG isolation and verification.
