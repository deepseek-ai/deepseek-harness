# Agent Note: Plugin detail documents

Status: implemented

English | [中文](2026-10-15-plugin-detail-documents.zh.md)

## Problem

Plugin cards and pages show a one-line description. A user choosing a plugin from a market, or checking what an installed bundle does, needs the longer description that package authors already write as a README, with screenshots, as extension marketplaces of code editors show it. The [market index](2026-10-02-plugin-market-index-format.md) carries list fields only, and an index document cannot carry a Markdown document and its images for every plugin.

Package READMEs of DSH's own packages are maintainer references rather than user descriptions, so an author needs a way to name a separate user document per language. Packages come from local installations, public npm, other registries, public Git hosts, and private repositories that only the user's Git credentials can read.

## Decision

Detail documents are read in a fixed order. For every package the order begins with the Markdown file that `meta.detail` in its `locale/<language>.json` names for the display language, falling back through shorter language prefixes to English, then the package README. A market entry page continues with the README of the repository directory the entry or its package declares, at the default branch. The [document order](../../../../packages/util/plugin-detail/README.md#document-order) of the stateless [`dsh-plugin-detail`](../../../../packages/util/plugin-detail/README.md) library is the single definition of the package steps; [`plugin-manager`](../../../../packages/boot/plugin-manager/README.md#bundle-detail-documents) and [`plugin-market`](../../../../packages/boot/plugin-market/README.md#plugin-detail-documents) document how they apply it.

`meta.detail` lives in the `locale/<language>.json` files that [plugin display metadata](../../../../docs/cookbook/adding-a-package.md#plugin-display-metadata) already uses, without a package-field fallback, and is read only for detail documents, so a malformed value fails the detail read and leaves the plugin's title, description, and icon intact. The package README stands in for the README npm shows, because npm shows the README file of the published version. A source that exists but fails stops the read with a reason instead of falling through, so a missing `meta.detail` file or an oversized repository is reported rather than replaced by a different document.

Bundle pages of **Plugins** are owned by `plugin-manager` and need no market: `readBundleDetail` reads an installed bundle from its directory, without network access or caching, and an official bundle offered before installation from the npm file CDNs at its offered version. Its image route resolves the bundle and document on every request, so the Host keeps no state. The bundle page shows the document first among its sections.

The Client chooses which npm file CDNs a read asks first: it asks the existing registry comparison of the Plugins page and passes `npmFileSources`, such as `['npmmirror']` when npmmirror answered fastest. The Host orders its configured CDNs by that list and asks no CDN the configuration omits, so the Host services do not depend on the Client package that owns the comparison.

Market entry pages are owned by `plugin-market`, which reads the entry version's source: the npm file CDNs for a public npm version, or the pinned Git commit. Repository files come from GitHub's raw host and the GitLab repository files API; an anonymous request to the repository's smart HTTP endpoint tells a missing file from a repository that needs credentials, and such a repository, or one on a host without an API, is read from a cached partial clone made with the user's Git configuration. Clones are depth-1 bare repositories without file contents until a file is read, limited per command and in total, and deleted when an operation on them fails or is cancelled. Any host of an http(s) repository URL may be cloned, over https, http, or ssh when `url.<base>.insteadOf` rewrites it: Git's credential helpers answer per host, so a clone sends a host only the credentials the user stored for it. The entry page shows the document first, then versions, then source. Neither page gives the document a heading of its own; the document's own headings name it.

The Host reads only addresses it derives from installed packages, configured indexes, package manifests, and fixed CDN and API hosts; a client names a bundle or an index entry, never a URL. Images beside a document are served by authenticated Host routes that accept only image types inside the document's root, with a sandbox CSP so an SVG opened directly cannot run on the API origin. Markdown renders through the shared `DetailDocument` primitive, which omits raw HTML instead of showing it as literal text, because a README's HTML is layout for HTML renderers and reads as noise in text form; absolute HTTP(S) images load in the browser without a referrer, and relative links stay text.

## Alternatives considered

**Bundle details through the plugin market.** An earlier design read bundle documents in `plugin-market` and contributed them through `plugins.detail.section`, so bundle pages showed nothing with the market bundle off and every bundle read went through the market's cache. Installed packages are local files that need no cache, so `plugin-manager` reads them directly with the shared library.

**A clone host allowlist and https-only clones.** Credential helpers, keychains, and `.netrc` already scope credentials to their host, so a market naming an unknown host receives no credentials for other hosts; an allowlist only blocked legitimate intranet repositories.

**Detail fields in the index format.** A generator could publish document URLs, but the Host would then fetch addresses a market chooses, and the index would still not carry images or private documents.

**npm tarball downloads.** A tarball covers every registry but downloads the whole package to read one file; the CDNs serve single files by exact version. Packages of other registries fall back to the entry's repository.

**Proxying absolute images through the Host.** The Host would fetch URLs a document author chooses from the user's machine, including intranet and loopback addresses. Browser loads keep that risk out of the Host, at the cost of disclosing the user's IP address to image hosts.

**Rendering raw HTML, and clickable relative links.** Many READMEs use HTML for layout, but rendering it requires sanitizing untrusted markup, so it is omitted; relative links would need a navigation target for every source. Both are deferred.

**Full or blob-limited clones.** A full clone downloads every file of large repositories, and a blob size limit still downloads every small file. A depth-1 partial clone downloads commits and trees and fetches only the files a document reads.

## Consequences

- Authors write a user document per language under `meta.detail`; other packages show their README.
- An installed bundle without `meta.detail` or a README shows no document; its declared repository is read only on market entry pages.
- A repository README is read at the default branch and can differ from the listed version.
- The first missing file of a public GitHub or GitLab repository costs one anonymous smart HTTP request, cached for `cacheTtlMs`.
- Private repositories work when the user's Git credentials reach the host.
- Unit tests cover the document order, CDN fallback, API and clone reads, size limits, eviction, and image paths with real local repositories; real-composition tests read an installed bundle's localized document through `plugin-manager` and a market entry's document through `plugin-market`, and serve their images through the composed profiles.
