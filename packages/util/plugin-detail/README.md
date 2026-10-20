---
description: "Plugin detail document selection without state: the meta.detail or README order, language fallback, image paths, and local and npm CDN file sources."
kind: "package-library"
---

# dsh-plugin-detail

English | [中文](README.zh.md)

## Summary

Library without state for plugin detail documents, the long Markdown description a plugin's page shows. It owns the order in which a package's document is chosen, the language fallback, image destinations beside a document, and two read-only file sources: a local package directory and a published npm version on public file CDNs. [`plugin-manager`](../../boot/plugin-manager/README.md#bundle-detail-documents) reads profile bundles with it, and [`plugin-market`](../../boot/plugin-market/README.md#plugin-detail-documents) reads market entries with it and adds repository sources.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a library, not a service or plugin: no `ctx`, no registrations, no state. Reads go through the file source the caller passes.

<a id="document-order"></a>
### Document order

A plugin's detail document is the first that exists, in this order:

1. **Locale `meta.detail`.** For each language of the chain, the package's `locale/<language>.json` is read, or, when that file does not exist, the same name with an upper-case two-letter region such as `locale/zh-CN.json`. When the file read declares `meta.detail`, that Markdown file is the document; otherwise the next language is tried.
2. **Package README.** `README.md`, `readme.md`, `Readme.md`, `README.markdown`, or `README`. A source that lists directories takes any letter case of `README`, `README.md`, and `README.markdown`.
3. **Repository README, market entries only.** The README of the repository directory that the market entry's `repository` names, otherwise the one that the package's `package.json` `repository` names, at the default branch. [`plugin-market`](../../boot/plugin-market/README.md#plugin-detail-documents) reads it; bundle pages in **Plugins** never read a repository.

`readPackageDocument(files, dir, languages, maxBytes, signal)` implements steps 1 and 2 and returns `undefined` when neither applies. `meta.detail` must be a `/`-separated path relative to the package root that ends in `.md` or `.markdown` and has no empty, `.`, or `..` segment, backslash, or URL scheme. A malformed locale file, a malformed `meta.detail`, and a named file that does not exist fail with `DetailFailure` `invalid`; the README is not read in their place.

`languageChain(language)` builds the chain: the language in lower case, each shorter prefix, then English, so `zh-Hans-CN` reads `zh-hans-cn`, `zh-hans`, `zh`, and `en`.

The returned Markdown has no byte order mark and no leading YAML front matter block.

### Images

`detailImage(document, destination)` resolves an image a document writes: relative to the document, or to the root of its files when it starts with `/`; a query or fragment is ignored. It returns the image's path and media type, or `undefined` for a destination that leaves the root, is malformed, or names a type other than PNG, JPEG, GIF, WebP, AVIF, and SVG.

### File sources

- `localFiles(root, revision)` reads a package directory. A path whose real location leaves the directory reads as absent. `revision`, such as the installed version, becomes part of the source's `key`.
- `npmFiles(name, version, sources, options)` reads a published version from jsDelivr, unpkg, and npmmirror in the given order. A 404 means the package has no such file; a network failure or another status asks the next CDN. `npmFileSourceOrder(configured, preferred)` puts the preferred CDNs that are configured first, in the preferred order, then the other configured ones.
- `fetchBody(url, maxBytes, signal, options)` reads one HTTP body up to `maxBytes`, following redirects within the URL's origin.

Every read is bounded by the caller's `maxBytes` and fails with `DetailFailure` `too-large` beyond it, or `network` when a source cannot be reached.

### Image responses

`detailImageResponse(outcome, cacheControl)` answers an image route: the image with `cacheControl`, 404 when there is none, or the failure's status (`too-large` 413, `network` 502, `denied` 403, `git-unavailable` 503, `invalid` 400) with the reason as its body and `Cache-Control: no-store`. Every response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, because an SVG opened directly would otherwise run scripts on the authenticated API origin.

-----

<a id="api"></a>
## API

```ts
import {
  DetailFailure, detailImage, detailImageResponse, languageChain, localFiles, NPM_FILE_SOURCES, npmFiles, npmFileSourceOrder,
  readPackageDocument,
} from '@deepseek-ai/dsh-plugin-detail'
```

`DetailFailureReason` and `NpmFileSource`, which Remote methods of other packages use, are also exported type-only from `@deepseek-ai/dsh-plugin-detail/types`.

`DetailFiles` is the source interface: `read(path, maxBytes, signal)` returns a file's bytes or `undefined`, and `readme(dir, maxBytes, signal)` returns a directory's README. Repository sources implement it in `plugin-market`.

-----

<a id="model-experience"></a>
## Model Experience

None, as this library selects documents for plugin pages and adds nothing to model requests.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Public npm only** — the file CDNs serve packages of the public npm registry; packages of other registries have no npm file source.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
