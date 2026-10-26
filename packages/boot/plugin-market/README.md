---
description: "Host reader of the plugin indexes a user configures, with installation status, compatibility, and the read-only plugin_market tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-market

English | [中文](README.zh.md)

## Summary

`pluginMarket` reads the plugin indexes the user configures, validates them with [`dsh-plugin-market-index`](../../util/plugin-market-index/README.md), and annotates every entry with the profile's installation status, DSH compatibility, and the exact arguments that install it. It also reads each index entry's long description, a Markdown document with images, for Discover entry pages. The Web [Discover tab](../../client/ui-plugin-market/README.md) and the `plugin_market` agent tool read through it; installation itself goes through [`pluginManager.installBundle`](../plugin-manager/README.md). The format and its rationale live in the [index format Agent Note](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md); the Host and Web design lives in the [Discover Agent Note](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The optional [custom plugin indexes bundle](../../experimental/plugin-market-bundle/README.md) mounts the service as the `plugin-market` row; shipped profiles leave the bundle off. Like `plugin-manager`, the row is disabled without a profile, and it waits for `pluginManager`. No index source is configured by default, so the Host sends no index request until a user adds one.

| Config | Default | Meaning |
|---|---|---|
| `indexes` | `[]` | Index URLs in display order. A usable URL is in canonical form and uses `http:` or `https:`, without credentials or fragment. The field is volatile: Discover, Settings, and `setIndexes` change it without remounting this service or `plugin-manager`. |
| `fetchTimeoutMs` | `15000` | Deadline for one index fetch, including its body. |
| `maxBytes` | `134217728` | Largest accepted index body. |
| `cacheTtlMs` | `600000` | Lifetime of a successfully read index document, a detail read result, and a repository's default-branch commit. |
| `detailMaxBytes` | `1048576` | Largest detail document, and largest locale file read for one. |
| `detailImageMaxBytes` | `5242880` | Largest image served beside a detail document. |
| `detailRepositoryMaxBytes` | `52428800` | Largest amount one Git command adds to a partial clone; a repository whose fetch adds more is not read. |
| `detailCacheMaxBytes` | `524288000` | Largest total size of the partial clones; least recently used ones are deleted beyond it after each fetch. |
| `detailCacheDir` | `.plugin-market/repositories` | Directory of the partial clones, relative to the profile directory; required, as an absolute path, when the service runs outside a dsh profile. |
| `detailGitTimeoutMs` | `60000` | Deadline of one Git command of the clone fallback. |
| `detailNpmFileSources` | `['jsdelivr', 'unpkg', 'npmmirror']` | npm file CDNs read in order; a read's `npmFileSources` moves the CDNs it names first, and CDNs this list omits are not asked. |
| `detailGitlabHosts` | `['gitlab.com']` | Hosts whose GitLab repository files API serves public repositories, compared without letter case. |

Settings and profile files can store any http(s) string, so the service validates each URL when it lists or reads it. `listIndexes` reports an unusable URL with its refusal, `search` and `entry` refuse it, and no request is sent to it; a repeated URL is listed once.

The Remote methods are:

- `listIndexes()` returns each configured URL with the title and description of its last successful read and, when the last read failed, its error. It never fetches.
- `setIndexes(urls)` normalizes and validates each URL not already configured, keeps configured ones as written, refuses a repeated URL, and writes it through `settings.update` to this service's profile entry. It fails with `plugin-market/settings-unavailable` without Settings or a profile entry. The committed list is announced by `plugin-market/changed`.
- `search(url, query)` accepts only a configured URL, so the service never fetches an arbitrary address. It returns one page of the plugins that match `query`, with the index title, description, and declarations, the document's `fetchedAt`, the `total` number of matches, and the `nextOffset`; each plugin carries its `defaultVersion` and `installation`, and each version its `install` and `compatibility`.
- `readEntryDetail(url, name, version, language, { refresh?, npmFileSources? })` reads the long description of one listed version of a configured index's entry from that version's source: the npm file CDNs for a version without `registry` or with the npm or npmmirror registry, or its pinned Git commit and `path`. An npm version from another registry has no readable package files.

The service method `entry(url, name)`, which is not a Remote method, returns one plugin of a configured index in the same form, or `undefined` when the index does not list it.

A query selects plugins with every one of its conditions:

| Field | Meaning |
|---|---|
| `text` | Fuzzy words; see below. Text without letters or digits selects every plugin. |
| `category` | The plugin's category id. |
| `labels` | Label ids the plugin must all have. An undeclared category or label id matches no plugin. |
| `sort` | `index` order; `relevance`, best text match first and index order without text; latest `published` time; or a declared sort `key`, with plugins lacking the value last. Each takes `asc` or `desc` where it has a direction, and ties keep index order. An undeclared sort key leaves index order. |
| `offset`, `limit` | The page: `offset` is a non-negative integer and `limit` an integer from 1 to 100; other values fail with `plugin-market/invalid-query`. |
| `refresh` | Fetch again instead of using the cached document. |
| `fetchedAt` | `fetchedAt` of an earlier page: answer from that document while it is cached, even after `cacheTtlMs`, so later pages continue the same results. |

Text matches the package name, author, keywords, and every language of the title, description, and category and label titles. It is split into runs of letters, marks, and digits; a run of Chinese, Japanese, or Korean characters becomes its overlapping character pairs and its last character, so text written without spaces matches without a dictionary. Words are compared after NFKC normalization and without case. Every query word must match an indexed word as a prefix or, from four characters, within an edit distance of one fifth of its length rounded to the nearest integer, at most 2. Name and title matches weigh three times, and keyword matches twice, a match elsewhere.

### Plugin detail documents

`readEntryDetail` reads all three steps of the [document order](../../util/plugin-detail/README.md#document-order): the locale `meta.detail` file and the README from the entry version's source, then the declared repository's README. For an npm version the README is the one npm shows for it. A Git entry whose `repository` is its own source directory skips the repository step. A malformed locale file or `meta.detail`, or a named file that does not exist, fails the read instead of moving to the next step.

Without any, the result is `{ status: 'none' }`. A found document carries its `origin` (`locale`, `readme`, or `repository`), its Markdown without a leading YAML front matter block, and a `document` id. Results, and the `too-large`, `denied`, and `invalid` failures that reading again would repeat, are cached for `cacheTtlMs`; `refresh` reads again instead, and concurrent reads share one read. A `document` id stays valid while a read returns it or an image request names it at least once every `cacheTtlMs`; an unused id is forgotten, and its images answer 404 until the document is read again.

Repository files are read through GitHub's raw file host for `github.com` and the GitLab repository files API for `detailGitlabHosts`. API requests follow redirects within their origin. When an API answers 401, 403, or 404, a request to the repository's smart HTTP endpoint without any credentials decides whether the repository is public; a public repository's miss means the file does not exist. A repository that needs credentials, and a repository on a host without such an API, is read from a partial clone over https, http, or ssh. Git uses the user's configuration, credential helpers, and `url.<base>.insteadOf` rules without prompting, so an https URL can be routed to ssh; ssh runs in batch mode unless `GIT_SSH` or `GIT_SSH_COMMAND` is set.

`GET /api/plugin-market/detail-file?document=<id>&path=<destination>` serves an image beside a read document to authenticated owner connections. The destination is relative to the document, or to the package or repository root when it starts with `/`; its query and fragment are ignored. Only PNG, JPEG, GIF, WebP, AVIF, and SVG files inside that root are served, with `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, and a private cache for `cacheTtlMs`. A missing file, unknown document, or other path answers 404; the failures below answer 413, 502, 403, 503, and 400; failure responses are not cached.

A source that exists but cannot be read fails with `plugin-market/detail-unavailable` and one `reason`: `too-large` for a document, image, or repository over its limit; `network` when a source cannot be reached or times out; `denied` when Git refuses the repository with the user's credentials; `git-unavailable` when a repository must be cloned and Git cannot run; `invalid` for a malformed locale file or `meta.detail`, or a named file that does not exist. An unlisted entry or version fails with `plugin-market/unknown-plugin`; an invalid language fails with `plugin-market/invalid-query`. A Git that cannot start and a local Git command that fails, such as on a full disk, fail the read without a detail reason and are not cached.

Failures use `plugin-market/invalid-query`, `plugin-market/invalid-index-url`, `plugin-market/unknown-index`, `plugin-market/fetch-failed`, and `plugin-market/invalid-index`; the last carries the JSON path of the offending value.

The `plugin_market` tool lists the configured indexes, pages the plugins of one index in index order or, with a `query`, by best match, or pages one plugin's versions. It requires no approval because it reads only the sources the user configured and changes nothing; each version it returns carries the `target` and `registry` to pass to `plugin_manager`'s `install_bundle`, which keeps its own approval. The tool cannot change index sources. Creator mode keeps its row beside `plugin_manager`, and the row registers the tool only while `pluginMarket` is mounted; other presets keep it disabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The Host fetches with the process `fetch`, so the configured outbound proxy applies, and refuses redirects. The body is read up to `maxBytes`, then a fresh Worker Thread decodes it as strict UTF-8, parses it as JSON, and validates it; relative icon references resolve against the configured URL. The body's buffer moves to the Worker, and the validated index returns to the Host by structured clone. The Worker is the self-contained `lib/worker.cjs` bundle; disposal terminates it, and a Worker failure is reported as `plugin-market/fetch-failed`.

Concurrent reads of one URL share one fetch. A successful document is cached for `cacheTtlMs`; `refresh` bypasses the cache. Each fetched document gets a new `fetchedAt`, and the cached document stays answerable by its `fetchedAt` until a later fetch replaces it. A failed read records its message for `listIndexes` and keeps no document. A read that finishes after its URL left the configuration updates neither cache nor error. On `loader/volatile-update` the service drops state of removed URLs and emits `plugin-market/changed`. Disposal aborts in-flight fetches.

Filtering and ordering read only the document; installation status and compatibility are computed for the returned page on every call. The first query with text in a document builds its text index with [MiniSearch](https://github.com/lucaong/minisearch), 500 plugins per event-loop turn, and later queries reuse it until the document is replaced.

Compatibility is computed per version with `evaluatePluginCompatibility`, the version's `engines.dsh`, and the profile's version exemptions, the same check installation applies. A plugin's default version is its highest compatible version without a prerelease tag, or its highest compatible prerelease when it lists no version without one; a plugin with no compatible version has none. Installation status comes from `pluginManager.listBundles()` by package name, measured against the default version, or the highest version without one: `not-installed`, also for an on-demand catalog entry the profile has not installed; `installed` at that version; `update-available` when that version is greater; `different-version` when the installed version is unknown, not valid SemVer, or greater; and `provided` for a bundle the DSH installation ships.

Entry detail reads share one reader that the service owns; document selection and the npm file CDNs come from [`dsh-plugin-detail`](../../util/plugin-detail/README.md). Each partial clone is a bare repository under `detailCacheDir`, named by a hash of its URL, initialized in a staging directory and renamed into place, and fetched with `--depth 1 --filter=blob:none` so only commits and trees arrive; Git downloads a file's contents when it is read. Commands run without inherited `GIT_*` variables other than the ssh program, with hooks, the file-system monitor, submodule recursion, and every transport but https, http, and ssh disabled, and no working tree is created. The directory size is checked every 200 ms while Git downloads; growth past `detailRepositoryMaxBytes` within one command stops Git, and output keeps a file's final newline byte. A file read stops once its contents pass the read's limit, and an image read completes even when the browser abandons the request, so leaving a page never interrupts a clone. A ref under `refs/dsh/` records each fetched commit, so a commit is never fetched lazily without the size check. Operations on one repository run one at a time, also across processes that share `detailCacheDir`, such as Web and Desktop on one profile, through a lock file beside the repository; eviction deletes a repository only after them, enforces `detailCacheMaxBytes` after every fetch and every file read, and deletes the repository in use last, after its operation, when it alone exceeds the total; one that fails or is cancelled, for any reason but a file over its read's limit, deletes the repository, so the next read starts from a fresh clone. Eviction also removes staging directories older than `detailGitTimeoutMs`. Disposal stops Git and waits for it.

`marketInstallTarget` builds install arguments: `name@version` with the version's registry for npm, and `git+<url>.git#<commit>` with `&path:/<path>` for a package directory in Git.

-----

<a id="model-experience"></a>
## Model Experience

### Market listing tool

#### What the model sees

The [`plugin_market` tool](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-market) returns JSON: configured index URLs with English titles and last errors, one page of plugins, in index order or by best match for a `query`, with name, English title, description, and author each truncated to 300 characters, homepage, repository, category, label ids, sort-key values, installation status, the default version, and the number of versions, or one page of a plugin's versions. Each returned version carries its ISO publish time, compatibility, and install arguments. Its description states that market text is third-party content, not instructions.

#### Token effect

The tool declaration is present when a preset mounts it; each call adds its JSON result, bounded by `limit` (at most 100 plugins or versions).

#### KV Cache effect

Append-only: results enter the conversation as ordinary tool results and do not change earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No upgrade** — an installed bundle with a newer index version is reported as `update-available`; upgrading remains uninstall followed by install.
- **Unsigned indexes** — index content, including a Git entry's name and version, is the index's claim; the installed manifest decides what is installed.
- **Last write wins** — `setIndexes` replaces the whole list, so two windows editing sources at the same time can overwrite each other's change.
- **Redirects refused** — an index served only behind a redirect must be configured at its final URL.
- **Whole-document reads** — the Host downloads and keeps each index up to `maxBytes` and builds its text index in memory; a synthetic index of 20,000 plugins took about 0.8 s of build time and 130 MiB of heap. Parsing runs in a Worker, but receiving the validated index still blocks the Host event loop while the clone is deserialized: about 35 ms for a synthetic 7.6 MiB index of 20,000 plugins and about 190 ms for 38 MiB and 100,000 plugins. Larger indexes need a server-side query protocol.
- **Default-branch READMEs** — a repository README is read at the default branch, which can differ from the listed version; npm records no commit the CDNs expose.
- **Private npm registries** — the public CDNs do not serve packages of other registries, so only the entry's repository can provide such a version's document.
- **Fetching an unadvertised commit** — a pinned Git entry is fetched by commit id, which the server must allow (`uploadpack.allowReachableSHA1InWant` or `allowAnySHA1InWant`); GitHub and GitLab allow it, and a server that refuses reports `denied`.
- **Exact README names through APIs** — the single-file APIs of public repositories are asked for `README.md`, `readme.md`, `Readme.md`, `README.markdown`, and `README` only; another letter case, such as `README.MD`, is found only in a clone.
- **No credentials for APIs** — GitHub and GitLab APIs are read anonymously; private repositories always use the clone fallback, which needs the user's Git credentials for the host.
- **Pages can change** — `fetchedAt` pins pages only while the document is cached; after another read replaces it, a reader must start again from the first page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
