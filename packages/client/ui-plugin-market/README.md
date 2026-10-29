---
description: "Discover tab of the Web Plugins page: search configured plugin indexes, read an entry, and install it."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-market

English | [中文](README.zh.md)

## Summary

Discover is the second tab of the **Plugins** page, after **Installed**. It lists the bundles that plugin indexes offer; users manage index sources, switch between indexes, search, filter by category and label, sort, open an entry's page, and install an entry after confirming it. Entry pages show each entry's long description as Markdown with images. The Host [`pluginMarket`](../../boot/plugin-market/README.md) service fetches and validates indexes; this package only presents them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open **Plugins** and select **Discover**. With no index source, the tab shows an empty state whose **Add index source** button opens the **Index sources** dialog. The dialog lists each source by index title, or by host before the first read, with its URL, the error of its last failed read, and a remove button, and keeps a notice that indexes come from third parties. A refused URL keeps the draft and says why: an unsupported scheme, credentials, or fragment; a URL already listed; or a deployment that cannot save sources. A newly added source becomes the selected index.

The toolbar holds the index menu, which switches indexes and ends with **Manage index sources…**; the search field; a **Labels** menu with multi-select checkmarks when the index declares labels; the **Sort** menu; and a refresh button. Controls wrap onto additional rows when space is limited, keeping search, filtering, sorting, and refresh available on mobile. Category pills, with **All** first, follow when the index declares categories.

Each card shows the icon, localized title, label tags, a one-line description, and the default version, author, and publish date, with one action: **Install** for an installable entry; a disabled **Install** whose tooltip says no version is compatible with the running DSH when the plugin has no default version and its highest version is neither compatible nor exempted; or **Installed**, **Update available**, or **Provided by DSH**, which switches to the Installed tab and opens that bundle's page when that tab lists it. Selecting a card opens the entry's page with its full description, compatibility notice, and, under the source heading, the default version's facts: author; homepage and source code repository, as links that open in a new tab, with the package directory beside the repository; the npm package and registry, or the Git repository, full commit, and directory; publish date; category; labels; and index title. The page shows the long description first, without a heading of its own, then **Versions**, then the source facts. The **Versions** list is in descending SemVer order; each row tags the recommended, prerelease, installed, incompatible, and exempted versions and offers **Install** for any other version installation accepts, except for a bundle DSH provides. The page's back link returns to the list with its search, filters, and sort intact.

**Install** chooses the default version and opens a confirmation dialog with the entry's icon, title, that version, the author, its source facts, an exemption notice when one applies, and a trust notice. Confirming opens the Plugins install dialog at its check screen with the entry's exact spec and registry; there is no spec form, and a refusal offers **Retry**. The registry an entry names applies to that install only.

The Host [`pluginMarket.search`](../../boot/plugin-market/README.md#use-this-package) matches, filters, orders, and pages; the tab sends the search text 250 ms after typing stops. Search matches names, authors, keywords, and every language of titles, descriptions, categories, and labels, fuzzily. Label filters must all match. **Sort** offers **Best match** while there is search text, **Default order**, **Publish date**, and each declared sort key, which starts in its declared direction; a directed sort adds a row that reverses it. Typing switches **Default order** to **Best match**, and clearing the text switches back. Categories, labels, and sort keys are listed by localized title. The list loads 50 entries and adds 50 with each **Show more**.

The description section shows the default version's long description in the active UI language: the version's locale `meta.detail` file, otherwise its package README, otherwise its repository README, in the [order `pluginMarket` documents](../../boot/plugin-market/README.md#plugin-detail-documents). While the document loads, the section shows three skeleton lines; an entry without a document shows no section; a failed read names its reason, such as a size limit, an unreachable source, or a refused repository, with **Retry**. Raw HTML is omitted, and a document taller than the section's height limit scrolls inside it. Relative image paths load from the Host beside the document, absolute HTTP(S) images load directly without a referrer, and relative links stay text. The section is the shared [`DetailDocument`](../ui-primitives/README.md#component-catalog) primitive.

Reading an index shows card skeletons. A failed read shows a short sentence with **Retry**, the Host's reason appears under the source in **Index sources**, and keeps the index's last listing; a failed read of the source list shows **Retry** in place of the tab. Discover re-reads sources on `plugin-market/changed` and connection reset, and recomputes installation status on `plugin-manager/changed`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Detail reads are kept in a second snapshot store keyed by index URL, entry, version, and language; a section starts its read when it renders, an npm version's read first asks the Host's registry comparison and passes `npmFileSources: ['npmmirror']` when npmmirror answered fastest, only the latest read of a key settles it, **Retry** asks the Host to read again instead of returning its cached result, and a connection reset forgets every read, because a restarted Host no longer knows the document ids its images use, so each shown section reads its document again. Image URLs resolve `api/plugin-market/detail-file` against `document.baseURI`, so they keep a deployment prefix and use the Desktop `dsh-app://app/` origin, which [`MarkdownText`](../ui-primitives/README.md) accepts for that route.

The plugin registers the `discover` entry, labelled **Discover**, into `plugins.tab`, the tab slot that [`ui-plugin-manager`](../ui-plugin-manager/README.md) declares; the owner props provide `install({ spec, registry?, title, version })` and `openPackage(name)`; Discover passes the entry's localized title and the chosen version. A React-free controller owns source reads, source edits, and the selected index's query and loaded pages in a snapshot store; selecting another index starts from the initial query. Later pages send the first page's `fetchedAt`, and a page from a replaced document reloads the list once; a second replacement fails the read. The listing keeps the query its results answer, so the empty-state wording follows the shown results while a new query loads or after it fails, and **Retry** repeats the read that failed: the first pages of a query or the next page. A change to the profile's bundles reloads every loaded page to refresh installation status, and a filter or sort key the index no longer declares leaves the query. The unsent search text, the open entry, and the confirmation are component state. Pure helpers in `presentation.ts` derive the query order from the text, drop undeclared ids, order declarations with `Intl.Collator` in the active UI language, and list source facts. Icons load lazily with `referrerpolicy="no-referrer"` and fall back to the default artwork.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders Host data in the browser and adds nothing to model requests.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No upgrade action** — an available update is shown as a status only.
- **Plain Markdown only** — detail documents omit raw HTML, including HTML images and layout, and relative links, including in-page anchors, are not clickable.
- **Remote icons** — URL icons are requested by the browser, which discloses the user's IP address to the image host. When the Web UI is served over HTTPS, the browser blocks or upgrades `http:` icons from an `http:` index, and a failed icon shows the default artwork.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
