# Agent Note: Web shell dist chunk split and directory layout

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-web-shell-dist-chunk-layout.zh.md)

## Problem

The apps/web shell previously built into a single ~1.2 MB (minified) index chunk, roughly 80% of it vendor bytes — KaTeX, the boot grammars and the shiki engine, react-dom, the markdown pipeline — fused with all the workspace shell code (about one fifth). Any one-line shell change rehashed the whole chunk, forcing returning clients to redownload everything; `dist/assets/` was a flat single-level spread of 100-plus files (the main chunk, 23 lazy-loaded grammar chunks, 59 KaTeX font faces, and sourcemaps intermixed), impossible to navigate.

## Decision

`apps/web/vite.config.ts` splits the shell into two initial chunks via `manualChunks` and sorts the output into directories via naming functions; the entire configuration contains zero regexes — an exact-package-name Set, a filename list, an extension list.

**Membership** (`VENDOR_PACKAGES`, by exact npm package name):

- `vendor` = the three heavy rendering families: math (katex), highlight (shiki), markdown (the micromark/mdast parse pipeline — the incremental React renderer above it is workspace code and not part of this). The live membership is `VENDOR_PACKAGES`; the list is the packages workspace code **imports directly**: the remaining private transitive dependencies (the oniguruma family, @shikijs/core, character tables, dozens more) are referenced only by listed members, so rollup's chunk coloring pulls them into vendor automatically; dependencies shared with the index side fall back to index, diluting it by a few KB — not a correctness issue.
- **Every vendor member must be react-free (the boundary invariant)**: rollup folds a module shared between the entry and a manual chunk into the manual chunk — one listed package importing react/jsx-runtime would drag the single shared react copy into vendor, away from index. The React side of markdown/math rendering is workspace code and naturally lives in index, so the whole react family stays pinned to index.
- `index` (the default chunk) = the react family (react, react-dom, scheduler, use-sync-external-store), vendored cordis, all workspace code, and the unlisted small pieces (anser, clsx).
- `@shikijs/langs` is special-cased: the boot grammars (`BOOT_GRAMMAR_FILES`: typescript, shellscript, json — the three that highlight.ts statically imports, all self-contained data modules with zero internal imports) go into vendor; the remaining 23 lazy-loaded grammars get no assignment and each keeps its own on-demand chunk.
- `index.html` is wired up automatically by vite: index loads via `<script>` and vendor via `<link rel="modulepreload">`, so the two chunks fetch in parallel with no waterfall.

**Directory layout** (`chunkFileNames` + `assetFileNames`):

- The `assets/` root keeps only the index and vendor js (with their adjacent sourcemaps) and css.
- Grammar chunks go under `assets/langs/`. The criterion is whether a chunk's `moduleIds` include an `@shikijs/langs` member, not the facade: the shared chunks of embedded grammars (php/ruby/mdx embed html+javascript, which rollup splits out for sharing) **have no facade**, so a facade criterion would miss them; index and vendor are excluded by name, because vendor legitimately carries the three boot grammars.
- Fonts go under `assets/fonts/` (`FONT_EXTENSIONS`: woff2/woff/ttf; all shipped files are KaTeX faces referenced by vendor.css — katex.min.css is imported by an index-side component, but CSS modules go through manualChunks like any module and follow `katex` into vendor.css; the browser fetches only woff2, on demand and only when a formula renders).
- Sourcemaps need no arrangement: rollup writes each `.map` next to its js and references it by bare relative filename, so when a chunk moves directories its map follows automatically.

All cross-directory references (index's dynamic imports into `langs/`, same-directory relative references among grammar chunks, vendor.css's relative references into `fonts/`) are emitted by the bundler, so the runtime needs zero accompanying changes; the host-side webserver serves the nested paths verbatim under its static prefix.

## Alternatives considered

- **Serving react and the other vendors from a CDN**: dsh web targets local/intranet hosts (often without internet access), so a CDN is simply unavailable; react is the platform seed external of every plugin bundle (the shell is its sole supplier), and switching to the CDN global-variable form would touch three places — the platform manifest, the seed, and the module table; the caching benefit is already delivered by the vendor split.
- **An inverse catch-all rule (everything in node_modules except the react family goes to vendor)**: membership cannot be read off the configuration, and small pieces like anser/clsx get misassigned to vendor; superseded by the positive exact-package-name list.
- **Regex family matching**: hard to read; exact package names plus rollup's automatic coloring of transitive dependencies make pattern matching unnecessary.
- **Identifying grammar chunks by facadeModuleId**: the facade-less shared chunks of embedded grammars would go undetected and fall back to the root directory; the `moduleIds` membership criterion covers both shapes.
- **Sheltering a react-edged rendering facade in vendor** (the historical react-markdown was one): rollup's shared-module folding would drag the single react copy into vendor, breaking the "react belongs to index" boundary; the constraint is codified as the list's boundary invariant.
- **Lazy-loading KaTeX wholesale, or turning the boot TypeScript grammar lazy**: either would change first-frame rendering behavior (the fallback for formulas / the first code block); that trade-off is independent of the dist layout and is decided separately.

## Verification

The audit tool ships with the repository: `node scripts/attribute-chunk-bytes.mjs <chunk.js>` (zero-dependency sourcemap VLQ byte attribution, aggregated by npm package / workspace directory). It verifies that vendor contains no workspace bytes, that the react family (including react/jsx-runtime) sits entirely in index, and that the npm side of index retains only the react family plus anser/clsx; the lazy grammar chunk count matches the `LAZY_GRAMMARS` table one to one; the browser keyless replay case is verbatim-identical to the pre-change baseline (apart from environment-specific local reds), so the two-chunk shell loads and renders with no regression.

## Consequences

- A shell code change rehashes only index (about one third of the dist output); vendor (about two thirds) stays cache-stable across shell releases and is invalidated only by dependency upgrades.
- `dist/assets/` is navigable: two js/css pairs at the root, on-demand grammars in `langs/`, fonts in `fonts/`.
- Maintenance cost: when workspace code adds a direct import of a rendering family's facade package, `VENDOR_PACKAGES` must be updated alongside (an omission merely dilutes index, nothing breaks); when the boot grammar set grows in highlight.ts without `BOOT_GRAMMAR_FILES` following, that grammar silently lands in index, visible only to a dist audit.
- The webserver's static surface has no compression yet, so the gzip size win is still on the table; transport-layer compression is a separate, independent decision.
