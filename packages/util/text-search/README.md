---
description: "Multilingual fuzzy search index for maintainers adding a search box or filter over an in-memory list."
kind: "package-library"
---

# dsh-util-text-search

English | [中文](README.zh.md)

## Summary

One search index for every in-memory search list in the Web client and for Host lists that feed it, such as `@` Session candidates. It implements the [client search rule](../../client/AGENTS.md#search-and-filter): results display in the current locale, matching covers every declared language and every field a user can identify an item by, and matching is fuzzy. Name matching uses [fuzzysort](https://github.com/farzher/fuzzysort), pinned to an exact version.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a **library, not a service or plugin**: no `ctx` and registers nothing. The caller owns each index; browser bundles inline it.

```ts
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { localizedValues, TextSearchIndex, type SearchKeys } from '@deepseek-ai/dsh-util-text-search'

interface Row { readonly id: string; readonly meta?: { readonly title?: LocalizedText; readonly description?: LocalizedText } }
const keys = (row: Row): SearchKeys => ({
  fuzzy: [row.id, ...localizedValues(row.meta?.title)],
  substring: localizedValues(row.meta?.description),
})

const rows: readonly Row[] = [{ id: 'plugin-filter', meta: { title: { en: 'Plugin filter', zh: '插件筛选' } } }]
const index = new TextSearchIndex(rows, keys)
const shown = index.search('筛选')

const next = index.update([...rows, { id: 'session-search' }], keys)
```

Build the index when the list changes and call `search` on every keystroke; a React component builds it in `useMemo` over the list. When the list changes often, as the sidebar's Session list does while replies run, keep the previous index and call `update` with the complete new list. Put short identifying text (names, titles, labels, readable ids) in `fuzzy` and longer text or opaque ids (descriptions, prompts, paths, UUIDs) in `substring`. Pass every language of a localized value, not the resolved display string.

-----

<a id="api"></a>
## API

| Export | Role |
|---|---|
| `new TextSearchIndex(items, keys)` | Calls `keys` once per item and prepares every key string. The index holds `items` by reference; callers must not mutate the list or its items. |
| `index.search(query)` | Returns the build list itself for a blank query. Otherwise splits the query on whitespace, keeps the items where every term matches some key, and orders them by total score, then build order. |
| `index.update(items, keys)` | Returns a new index over the complete new list; additions, removals, reorders, and changed keys are all expressed by that list. Key strings this index already prepared are reused, strings no item uses any more are dropped, and this index stays valid. |
| `localizedValues(text)` | Every language of a `LocalizedText`; `[]` for `undefined`. |
| `SearchKeys` | `{ fuzzy?, substring? }`; `undefined` and empty values never match. |

Matching rules:

- Both key kinds and the query are compared after NFKC normalization, removal of Latin-style diacritics (U+0300–U+036F) and letter strokes, and lowercasing, so `web` matches `ＷＥＢ` and `lodz` matches `Łódź`. Marks that change a letter in other scripts, such as kana voicing, stay. A query term made only of removed marks is ignored.
- A **`fuzzy`** key matches when the term is a substring of it, or a fuzzysort subsequence of it that starts at a word start (after a separator, at a camel-case hump, or at any CJK character), so `cpt` matches `compact` but `fab` does not match `Refactor build`.
- A **`substring`** key matches only when the term is a contiguous substring. A subsequence scattered across a sentence does not count, so `invoice` does not match an unrelated task prompt.
- Each term scores by tier: `fuzzy`-key prefix, then `fuzzy`-key substring, then fuzzy subsequence by fuzzysort score, then `substring`-key hit; equal scores keep the build order.

<a id="model-experience"></a>
## Model Experience

None, as the package filters caller-owned lists for search boxes and registers nothing model-facing.

#### KV Cache effect

None; consumers own any request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No typo tolerance** — a transposed or wrong letter (`pluign`) does not match; fuzzysort matches subsequences only.
- **Dictionary copy matches one language** — client locale dictionaries resolve only the active language through `t()`, so lists whose labels come from them, such as built-in `/` commands and shortcut names, match those labels only in the current language. Their names still match in every language.
- **Plugin market and file `@` search are separate** — the plugin market keeps its MiniSearch index on the Host, and file references keep their path ranking; both serve larger lists than this package targets.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

fuzzysort is pinned to an exact version because its scores order every search list; an upgrade changes visible ordering and must update the affected tests together.

</details>
