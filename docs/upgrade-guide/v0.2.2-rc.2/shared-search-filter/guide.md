---
kind: upgrade-guide
description: "ui-primitives no longer exports rankByName, and popupSelect commands no longer accept searchMode."
---

# Shared search filter replaces rankByName and searchMode

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-client-ui-primitives` exported `rankByName(items, query)`, which ranked items by an ordered subsequence of `name` or `label`. It is removed. `@deepseek-ai/dsh-client-ui-commands` accepted `searchMode: 'substring' | 'fuzzy-label'` on a `popupSelect` command spec and exported the `PopupSearchMode` type; both are removed. Every popup now filters its options one way: labels match fuzzily and details match as substrings, ranked within each group. The shared search is [`TextSearchIndex`](../../../../packages/util/text-search/README.md) in `@deepseek-ai/dsh-util-text-search`. Plugin authors who import `rankByName`, or who set `searchMode` or import `PopupSearchMode`, are affected.

## Migration

1. Replace `rankByName(items, query)` with a `TextSearchIndex` imported from `@deepseek-ai/dsh-util-text-search`: build `new TextSearchIndex(items, item => ({ fuzzy: [item.name, item.label] }))` when the list changes, and call `index.search(query)` per query. Add that package to the plugin's `devDependencies` for a Client plugin or `dependencies` for a Host plugin. Put descriptions or other long text in `substring`, and pass every language of a `LocalizedText` through `localizedValues`.
2. Delete `searchMode` from each `popupSelect` spec and remove any `PopupSearchMode` import.
3. Confirm the plugin typechecks, and that typing part of an option label in its popup still finds that option.
