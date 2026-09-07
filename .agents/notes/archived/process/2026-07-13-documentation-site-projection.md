# Agent Note: Project canonical documentation into the website

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-13-documentation-site-projection.zh.md)

## Problem

The repository needs a navigable documentation website without turning the website directory into a second documentation source. Copying package guides, architecture pages, or generated catalogs into a site-specific tree allows the two copies to drift, while pointing VitePress directly at the repository root couples public URLs and navigation to the internal file layout. Repository-relative links also need different destinations on the website: published pages stay inside the site, but source files and unpublished contributor documents belong on GitHub.

## Decision

Canonical Markdown remains in the repository tier that owns it. Product-facing guides live under `docs/user/`, generated reference remains in the existing generated catalogs, and architectural and cookbook pages remain at their existing `docs/` paths.

`website/docs.ts` is an explicit publication manifest. Each entry maps one canonical source file to a stable public route, sidebar, section, and order. Adding or removing a published page is therefore a reviewable manifest change rather than an implicit directory crawl.

`scripts/project-doc-site.ts` projects the manifest into the ignored `website/.generated/` directory before VitePress starts or builds. The generated tree follows public routes so VitePress navigation, locale detection, and local search share the same route vocabulary. Each page receives an `editSource` frontmatter field pointing to its canonical repository file; the edit-link callback reads only that page data, so public URLs remain independent of the source layout.

Locale home projections retain only the canonical YAML frontmatter. The repository-facing body keeps its H1 and bilingual source links, while the frontmatter implements the [locale-preserving quick-start redirect](../../../../docs/user/index.md) and the site navigation owns locale switching.

The projector parses Markdown links without reserializing the document. A link to another published source becomes a site-relative route; a link to an unpublished repository file becomes a source link under the `deepseek-ai/deepseek-harness` repository home; a repository image is copied into the generated tree and referenced from there ([why](2026-08-06-doc-site-carries-its-images.md)). Missing relative targets fail projection. Unit tests pin these transformations, and `docs:check` runs the projector tests plus a production VitePress build as part of `doc-sync` and the parallel documentation gates.

`verify-public-repository-links` rejects references to the unavailable legacy repository from tracked files. Source and edit links use the current repository home.

`website/AGENTS.md` is the only maintained Markdown file in the website subtree. The projector test enumerates tracked and unignored files and rejects any other website Markdown, so site-specific locale, route, API, or generated source copies cannot bypass the publication manifest.

Mermaid renders the canonical diagrams. The website workspace explicitly declares the five packages that `vitepress-plugin-mermaid` asks Vite to prebundle because pnpm's strict dependency isolation otherwise makes those transitive packages unavailable to the local development server.

The configured Markdown renderer keeps a build-local cache for non-Mermaid, non-snippet code fences, keyed by the exact content, info string, delimiter, and token attributes. About half of the bilingual projection's code fences repeat, so Shiki renders each distinct representation once. Mermaid fences bypass the cache because the plugin output includes a token-position id, and VitePress snippets resolve their source files during rendering. The cache is enabled only for production builds, is discarded with the renderer after each build, and does not change the emitted fence HTML.

Site publication remains separate from site construction. A dedicated GitHub Actions workflow runs the existing documentation gates, uploads `website/.dist` as a Pages artifact, and deploys only after the build succeeds. `actions/configure-pages` supplies the destination's base path to VitePress at build time, so the private Pages origin, a later public project path, and a custom domain do not require distinct checked-in configurations. Pages visibility remains a repository hosting setting rather than a workflow permission.

## Alternatives considered

**Commit copied Markdown under `website/`.** This makes VitePress setup direct, but every copied guide or API table gains two owners and requires a synchronization convention that cannot identify which copy is authoritative.

**Make `website/` the canonical home for every published page.** This keeps one copy but moves architecture, generated reference, and contributor-facing material away from their repository ownership tiers merely to satisfy a renderer.

**Discover every Markdown file automatically.** This minimizes manifest maintenance but publishes internal documents accidentally, exposes source moves as URL changes, and produces navigation from incidental directory order.

**Use filesystem symlinks.** Symlinks preserve a single source but do not solve public routing or repository-relative links, and their behavior is less predictable across local development, package tooling, and hosted CI environments.

**Build only in a deployment workflow.** A deployment job can reveal rendering failures after merge. Keeping the production build in `doc-sync` makes the same failure visible locally and in ordinary CI even when no public deployment exists.

**Hard-code the public project path.** A fixed `/deepseek-harness/` base works for the public project URL but not for the unique origin assigned to a private Pages site or for a future custom domain. Consuming Pages metadata keeps one build contract across those destinations.

## Consequences

Documentation facts have one editable home, public routes remain stable across source moves, and the site can include generated references without committing another generated copy. Local development watches canonical inputs and regenerates the disposable projection. The layout gate makes an obsolete site-specific Markdown tree a merge failure instead of ignored build input. Publication to Pages runs as a manual dispatch from a release tag, so the site presents a released snapshot rather than the current master ([why](2026-08-21-documentation-site-tag-release.md)).

The publication manifest is a maintained allowlist, and link projection adds a small repository-specific build adapter. A new kind of Markdown link behavior needs a projector test. Mermaid support also increases the client bundle size, but preserves diagrams already used by the canonical documentation.
