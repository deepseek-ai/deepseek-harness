# Agent Note: The documentation site carries its own images

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-doc-site-carries-its-images.zh.md)

## Problem

`scripts/project-doc-site.ts` rewrote every repository-relative target that the publication manifest does not publish into a GitHub URL, and for an image that meant `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`. Nothing in the site build copies files: `srcDir` is the disposable `.generated` tree, VitePress sets no `publicDir` (its default, `<srcDir>/public`, is inside the tree the projector deletes on every run), and only Markdown is written there.

That works only for a public repository. This one is private, and `raw.githubusercontent.com` answers 404 to an unauthenticated request — a browser session on github.com does not authenticate it either, since GitHub's own UI serves private blobs through separately signed URLs. Every image on the site was therefore broken for every reader, and no gate said so: `verify-md-links` and the projector check that the target file *exists in the repository*, which is a different question from whether a site reader can fetch it.

## Decision

`rewriteMarkdown` takes an optional `placeImage(absPath): string`. When a page references an image the manifest does not publish as a page, the projector copies that file into the generated tree beside the page and rewrites the reference to `./<basename>`; Vite then bundles it like any other site asset. Nothing about repository visibility can reach the published page.

The copy lands beside the page rather than in a shared asset directory. Each locale's route tree gets its own copy, so one relative URL is correct from both `guide/` and `en/guide/` without computing per-locale prefixes, and a page's assets are removed with the page when the manifest drops it. One map claims every projected path — pages and images alike — so a second source for one path throws, in the same spirit as the existing duplicate-route check, rather than letting whichever wrote last win.

Only a regular file whose real path stays inside the repository is copied; anything else fails the projection naming the page and the target. Link rewriting needs to know a target *exists*, but publication copies its bytes onto the site, so a reference escaping the repository — through `../..` or a symlink out of the tree — would put a build-machine file on a published page. The reference's `?query` or `#fragment` rides along to the placed URL exactly as the GitHub branch has always carried it, and the file name is percent-encoded because the destination is a Markdown inline target.

`docsSourceFiles()` reports the placed images alongside the Markdown, so the dev server's watcher re-projects when a screenshot is replaced instead of serving the previous copy until something touches the page.

`placeImage` is optional because `rewriteMarkdown` is also called directly by its spec, where no generated tree exists. Without it the GitHub-raw fallback points at the public source home, which keeps that seam honest for a consumer that only rewrites text.

Canonical Markdown keeps writing ordinary repository-relative image paths, so the same file renders on GitHub and on the site. No document carries a site-absolute URL to satisfy VitePress.

## Alternatives considered

**Set `publicDir` outside `.generated` and reference site-absolute URLs.** Fewer moving parts in the projector, but every image reference would then be broken when the same Markdown is read in the repository, and canonical docs are read both ways.

**Host images on the assets branch, as demo GIFs already are.** That branch exists to keep large binaries out of the main history, and its raw URLs have exactly the same visibility problem. It remains the right home for recordings; it does not solve this.

**Wait for the repository to become public.** It would fix the symptom without making the site self-contained, and the site would silently depend on GitHub's availability and rate limits for every image.

## Consequences

Images in published documentation now work regardless of who is reading or whether the repository is public, and the site build has no runtime dependency on GitHub for them. The generated tree grows by one copy of each referenced image per locale — the four screenshots in the model-provider guide add roughly 270 KB per locale.

Images referenced from *unpublished* documents are untouched. A text-only projection resolves them against the public source home; a document that is not on the site has no site build to carry its assets.

## Testing

`scripts/project-doc-site.spec.ts` covers the placer receiving the resolved absolute path and the returned URL landing in the Markdown, a placed reference keeping its fragment, a published page link still resolving to its route when a placer is present, and the unchanged GitHub-raw fallback when no placer is supplied. `publishableImage` is covered directly: a regular file inside the repository resolves, while a symlink whose target escapes it, a path outside it, and a directory are all refused. `pnpm docs:check` builds the site with the model-provider guide's screenshots and fails on a missing source; the copied files and their `./<basename>` references were verified in `website/.generated` and in a running `docs:dev` (`naturalWidth > 0` in both locales).
