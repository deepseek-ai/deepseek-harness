---
description: "Host reader of the plugin market indexes a user configures, with installation status, compatibility, and the read-only plugin_market tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-market

English | [中文](README.zh.md)

## Summary

`pluginMarket` reads the plugin market indexes the user configures, validates them with [`dsh-plugin-market-index`](../../util/plugin-market-index/README.md), and annotates every entry with the profile's installation status, DSH compatibility, and the exact arguments that install it. The Web [Discover tab](../../client/ui-plugin-market/README.md) and the `plugin_market` agent tool read through it; installation itself goes through [`pluginManager.installBundle`](../plugin-manager/README.md). The format and its rationale live in the [index format Agent Note](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md); the Host and Web design lives in the [Discover Agent Note](../../../.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The optional [custom plugin markets bundle](../../experimental/plugin-market-bundle/README.md) mounts the service as the `plugin-market` row; shipped profiles leave the bundle off. Like `plugin-manager`, the row is disabled without a profile, and it waits for `pluginManager`. No index source is configured by default, so the Host sends no market request until a user adds one.

| Config | Default | Meaning |
|---|---|---|
| `indexes` | `[]` | Index URLs in display order. A usable URL is in canonical form and uses `http:` or `https:`, without credentials or fragment. The field is volatile: Discover, Settings, and `setIndexes` change it without remounting this service or `plugin-manager`. |
| `fetchTimeoutMs` | `15000` | Deadline for one index fetch, including its body. |
| `maxBytes` | `134217728` | Largest accepted index body. |
| `cacheTtlMs` | `600000` | Lifetime of a successfully read document. |

Settings and profile files can store any http(s) string, so the service validates each URL when it lists or reads it. `listIndexes` reports an unusable URL with its refusal, `search` and `entry` refuse it, and no request is sent to it; a repeated URL is listed once.

The Remote methods are:

- `listIndexes()` returns each configured URL with the title and description of its last successful read and, when the last read failed, its error. It never fetches.
- `setIndexes(urls)` normalizes and validates each URL not already configured, keeps configured ones as written, refuses a repeated URL, and writes it through `settings.update` to this service's profile entry. It fails with `plugin-market/settings-unavailable` without Settings or a profile entry. The committed list is announced by `plugin-market/changed`.
- `search(url, query)` accepts only a configured URL, so the service never fetches an arbitrary address. It returns one page of the plugins that match `query`, with the index title, description, and declarations, the document's `fetchedAt`, the `total` number of matches, and the `nextOffset`; each plugin carries its `defaultVersion` and `installation`, and each version its `install` and `compatibility`.

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

Failures use `plugin-market/invalid-query`, `plugin-market/invalid-index-url`, `plugin-market/unknown-index`, `plugin-market/fetch-failed`, and `plugin-market/invalid-index`; the last carries the JSON path of the offending value.

The `plugin_market` tool lists the configured indexes, pages the plugins of one index in index order or, with a `query`, by best match, or pages one plugin's versions. It requires no approval because it reads only the sources the user configured and changes nothing; each version it returns carries the `target` and `registry` to pass to `plugin_manager`'s `install_bundle`, which keeps its own approval. The tool cannot change index sources. Creator mode keeps its row beside `plugin_manager`, and the row registers the tool only while `pluginMarket` is mounted; other presets keep it disabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The Host fetches with the process `fetch`, so the configured outbound proxy applies, and refuses redirects. The body is read up to `maxBytes`, then a fresh Worker Thread decodes it as strict UTF-8, parses it as JSON, and validates it; relative icon references resolve against the configured URL. The body's buffer moves to the Worker, and the validated index returns to the Host by structured clone. The Worker is the self-contained `lib/worker.cjs` bundle; disposal terminates it, and a Worker failure is reported as `plugin-market/fetch-failed`.

Concurrent reads of one URL share one fetch. A successful document is cached for `cacheTtlMs`; `refresh` bypasses the cache. Each fetched document gets a new `fetchedAt`, and the cached document stays answerable by its `fetchedAt` until a later fetch replaces it. A failed read records its message for `listIndexes` and keeps no document. A read that finishes after its URL left the configuration updates neither cache nor error. On `loader/volatile-update` the service drops state of removed URLs and emits `plugin-market/changed`. Disposal aborts in-flight fetches.

Filtering and ordering read only the document; installation status and compatibility are computed for the returned page on every call. The first query with text in a document builds its text index with [MiniSearch](https://github.com/lucaong/minisearch), 500 plugins per event-loop turn, and later queries reuse it until the document is replaced.

Compatibility is computed per version with `evaluatePluginCompatibility`, the version's `engines.dsh`, and the profile's version exemptions, the same check installation applies. A plugin's default version is its highest compatible version without a prerelease tag, or its highest compatible prerelease when it lists no version without one; a plugin with no compatible version has none. Installation status comes from `pluginManager.listBundles()` by package name, measured against the default version, or the highest version without one: `not-installed`, also for an on-demand catalog entry the profile has not installed; `installed` at that version; `update-available` when that version is greater; `different-version` when the installed version is unknown, not valid SemVer, or greater; and `provided` for a bundle the DSH installation ships.

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
- **Unsigned indexes** — index content, including a Git entry's name and version, is the market's claim; the installed manifest decides what is installed.
- **Last write wins** — `setIndexes` replaces the whole list, so two windows editing sources at the same time can overwrite each other's change.
- **Redirects refused** — an index served only behind a redirect must be configured at its final URL.
- **Whole-document reads** — the Host downloads and keeps each index up to `maxBytes` and builds its text index in memory; a synthetic index of 20,000 plugins took about 0.8 s of build time and 130 MiB of heap. Parsing runs in a Worker, but receiving the validated index still blocks the Host event loop while the clone is deserialized: about 35 ms for a synthetic 7.6 MiB index of 20,000 plugins and about 190 ms for 38 MiB and 100,000 plugins. Larger markets need a server-side query protocol.
- **Pages can change** — `fetchedAt` pins pages only while the document is cached; after another read replaces it, a reader must start again from the first page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
