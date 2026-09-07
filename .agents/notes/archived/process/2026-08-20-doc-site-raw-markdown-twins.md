# Agent Note: Raw-Markdown twins and llms.txt on the documentation site

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-20-doc-site-raw-markdown-twins.zh.md)

## Problem

The documentation site serves rendered HTML only, so an agent reading the docs has to scrape VitePress markup or fall back to the repository, where links and image references follow source layout rather than public routes. Claude's platform documentation set the convention this feature adopts: append `.md` to any page URL for the page as raw Markdown, with a root `llms.txt` as the agent-facing index. [The site projection](2026-07-13-documentation-site-projection.md) rewrites every page's links for the public site already, so the gap was serving that projection as plain Markdown.

## Decision

`vitepress build` ends by emitting a raw-Markdown twin of every published route into the build output. `emitRawMarkdownPages` runs the same manifest-and-projector pass that fills `website/.generated/`, but writes `<outDir>/<route>` with raw page content: no `editSource`/`outline` projection frontmatter, no locale-home truncation — frontmatter is VitePress rendering configuration, so the twin drops it and keeps the body — and the same repository-chrome stripping as the rendered site. Referenced images are copied beside the twins.

One projection serves both trees because its site-internal links are relative. `./sibling.md` renders as a clean URL on the HTML site and resolves file-to-file in the raw tree, so the twins need no second link-rewriting mode. Every route is emitted, including the frontmatter-only locale homes, because published pages link to them and the raw tree must stay link-closed; a spec walks every emitted relative link to pin that closure.

An index route renders as a directory URL, so "append `.md`" lands on `<dir>.md` once the trailing slash is dropped; each index route therefore also emits a parent-level alias twin at that path. The alias is not a copy — a copied `index.md` would carry its relative links one directory too high — but its own projection over the alias route, resolved against the canonical manifest so links keep targeting canonical twins. The root home has no parent to alias into; `/` is documented as `/index.md`.

Each production entry point resolves the VitePress configuration, requires `outDir` to be a proper child of the site root, and requires its nearest existing parent to resolve inside the real site root. It unlinks a link-shaped output without traversing its target and removes a real output directory before bundling. This project-owned preparation covers MPA builds, which do not empty their final output directory, and prevents removed routes or assets from surviving a rebuild. The later raw-twin pass treats files created by the current VitePress build as occupied: a twin or image may never overwrite one, such as a `public/` copy, and a name collision fails the emission.

`llms.txt` is generated from the publication manifest at the site root: both locale trees in sidebar order, one `- [label](<base><route>): <section>` row per page, links site-absolute under the deploy-time `DOCS_BASE`. Locale homes stay out — the file itself is the agent entry point.

The dev server serves the same surface for navigations and header-less clients. A middleware in the doc-projector plugin projects `.md` requests from their canonical sources per hit and generates `llms.txt` on demand, so `docs:dev` matches production without a rebuild; an in-page `fetch()` (`Sec-Fetch-Dest: empty`) deliberately still reaches Vite in dev, while production static hosting answers it with the raw file.

`verify-doc-site-fragments`, the post-build gate, fails the build when any route's twin or `llms.txt` is missing from the output, so deleting the `buildEnd` wiring cannot pass CI.

## Alternatives considered

**`vitepress-plugin-llms`.** Actively maintained, MIT, used by the Vite, Vue, and Vitest sites; it generates per-page Markdown, `llms.txt`, `llms-full.txt`, and dev-server responses. Two hard-coded behaviors break this site. It flattens `dir/index.md` to `dir.md` with no opt-out while leaving in-page links unrewritten, which 404s every relative link into a section landing page — this site publishes seven index routes per locale. And it rewrites image references to root-absolute hashed bundle paths without the site base, which 404s on this subpath GitHub Pages deployment; its adopters deploy at domain roots and never hit either. Its `llms.txt` also reads sidebars only from the top-level theme config, not this site's per-locale ones. Correcting all that means a fork or a post-processing layer coupled to plugin internals — more owned surface than the small emitter reusing the tested projector.

**Emit through Vite's `publicDir`.** Vite supports one public directory and the site already points it at the tracked `website/public/`; generated twins would land in a tracked tree the layout gate forbids.

**Absolute links inside the twins.** platform.claude.com links absolutely because its host is fixed. This site's base varies between local `/` and the Pages subpath, and the projector's relative links resolve in both trees as they are, so absolute rewriting would add a second link grammar without improving resolution.

**Skip locale homes in the raw tree.** Published pages link to `docs/user/index.md`, so omitting the home routes breaks link closure. The body that survives chrome stripping (the H1) costs nothing, and the redirect frontmatter means nothing outside VitePress.

## Consequences

Agents fetch any page as plain Markdown by dropping the URL's trailing slash and appending `.md`, and discover the whole set at `/llms.txt`; the rendered site is unchanged. The build output carries one extra Markdown file per route, an alias per index route, and image copies beside them — kilobytes against the bundled assets. Twin content keeps GitHub-style heading text while the rendered site slugs punctuation-heavy headings differently; agents resolve headings themselves, so no gate covers raw-tree fragments. Deferred as unneeded for the twins' audience: `llms-full.txt`, and a per-page "view as Markdown" control, which would require a theme directory the stock-theme site deliberately lacks.
