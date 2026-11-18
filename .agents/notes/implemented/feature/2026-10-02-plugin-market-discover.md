# Agent Note: Plugin market Discover page and index reader

Status: implemented

English | [中文](2026-10-02-plugin-market-discover.zh.md)

## Problem

The [plugin market index format](2026-10-02-plugin-market-index-format.md) lets a market publish installable bundles in one document, but DSH needs a reader that fetches indexes safely, a place where users choose index sources and browse entries, and a path from an entry to the existing installation flow. No official market exists, so DSH cannot ship a default source; the sources are user data.

The plugin manager owns profile package operations and must not remount while an installation runs. Market configuration that a user edits from the Web therefore cannot be an ordinary configuration field of `plugin-manager`.

## Decision

The feature ships as the experimental optional [custom plugin indexes bundle](../../../../packages/experimental/plugin-market-bundle/README.md), off by default, which mounts both rows below; with it off, neither the service, the Discover tab, nor the `plugin_market` tool exists, and the Plugins page shows no tabs. A separate Host service, [`pluginMarket`](../../../../packages/boot/plugin-market/README.md), reads indexes. It requires `pluginManager` for read-only calls and never writes the profile. Its `indexes` configuration field is volatile: Settings writes only volatile fields, and the Loader commits a volatile-only change into the running reference without remounting any plugin. Other fields (`fetchTimeoutMs`, `maxBytes`, `cacheTtlMs`) are ordinary configuration.

Index URLs use `http:` or `https:`, without credentials or fragment. `file:` is excluded because relative icon references would resolve to URLs a browser cannot load. `search` and `entry` accept only a configured URL, so the Host never fetches an address a client supplies. The Host fetches through the process proxy, refuses redirects, bounds the body, and validates with the shared format package; an invalid index affects only its own URL.

Indexes can reach the default 128 MiB `maxBytes`, so clients never receive or filter a whole index. `search` filters, matches text, orders, and pages on the Host and returns at most 100 entries; `entry` returns one plugin by name for the tool. Text matching is fuzzy and covers the package name, author, keywords, and every language of the title, description, and category and label titles, because a person may search in any language a market writes. A Chinese, Japanese, or Korean run is indexed as overlapping character pairs and its last character, so queries match without a word dictionary. [MiniSearch](https://github.com/lucaong/minisearch) builds the text index on the first text query of each document and yields between chunks. Each page carries its document's `fetchedAt`, and a later page sent with it is answered from that document while it is cached, so paging stays consistent across cache expiry; a client whose document was replaced starts again from the first page.

Each returned entry carries the profile's installation status, its compatibility computed by `evaluatePluginCompatibility` with the profile's version exemptions, and `install`, the exact arguments from `marketInstallTarget`. That is the only place install arguments are built; the Web page and the model tool consume it.

The Web [Discover tab](../../../../packages/client/ui-plugin-market/README.md) is its own client plugin. [`ui-plugin-manager`](../../../../packages/client/ui-plugin-manager/README.md) declares a `plugins.tab` slot and shows **Installed** and each contributed tab under the page header, because browsing a market and managing installed bundles are separate tasks of equal rank. The owner props provide `install(spec, registry?)` for a spec the person confirmed in the tab, which opens the existing install dialog at its check screen without the spec form, and `openPackage(name)`, which opens an installed bundle's page. A registry an entry names applies to that install only and is never remembered as the dialog's choice, so one market cannot redirect later manual installs. Discover confirms each install with the entry's origin and a trust notice, and keeps source management, which adds a code origin, in a dialog with its own trust notice. Each entry has a page with its full description, source facts, and every listed version; **Install** on a card chooses the default version, and the page can install any other version installation accepts. Indexes are browsed one at a time; categories, labels, and sort keys stay opaque and display in localized title order; entries missing the selected sort value come last in both directions.

A read-only `plugin_market` tool lists indexes and pages entries, returning the `target` and `registry` that `plugin_manager`'s `install_bundle` accepts. It requires no approval; installation keeps `plugin_manager`'s approval. The tool cannot change index sources, because adding a source introduces a new code origin.

## Alternatives considered

**Market fields on `plugin-manager`.** A non-volatile field would remount `plugin-manager` when the Web edits it and interrupt package operations it owns. Even with a volatile field, a separate service guarantees that market configuration never reaches `plugin-manager`, at the cost of one more package and service.

**Configuring indexes only in `cordis.yml`.** Most users do not edit `cordis.yml`, so Discover would stay empty for them.

**Fetching indexes in the browser.** CORS, the Host's proxy configuration, and validation where untrusted data enters favor Host fetches.

**Filtering in the browser.** It needs the whole annotated index in every client, which grows with the index and recomputes compatibility for every entry on each read.

**A query protocol on the index host.** It would keep large indexes off the Host but requires a server for every market, which a static index file avoids. It remains the next step if indexes outgrow the Host.

**Merging all configured indexes into one list.** Opaque ids from different markets may collide with different meanings, and duplicate package names need a conflict rule. Per-index browsing avoids both.

**Rendering Discover inside `ui-plugin-manager`.** The page would depend on the market Remote and grow further; a slot keeps the page usable without the market and lets the market plugin own its copy and state.

**Discover as a section under the Installed groups, installing through the spec form.** Finding it requires scrolling past every installed bundle, and the form asks a person to review a spec they never typed. Tabs give browsing its own entry point, and a confirmation with the entry's origin followed by the check screen replaces the form.

**An approval for `plugin_market`.** Listing changes nothing and reads only sources the user configured; requiring approval would add a prompt without protecting an operation. The installation step keeps its approval.

**An upgrade action.** Upgrading changes the documented "uninstall, then install" behavior and is deferred; Discover shows `update-available` as a status.

## Consequences

- Users browse and install third-party bundles without knowing a spec, and the existing install dialog, registry fallback, build-script approval, and compatibility refusal apply unchanged.
- The Settings form also shows `indexes`, because Settings lists every volatile field.
- An `http:` index, including the install specs it lists, can be altered in transit; a market reached over an untrusted network needs `https:`.
- URL icons are requested by the browser and disclose the user's IP address to image hosts; Discover loads them without a referrer.
- Market text reaches users and, through `plugin_market`, models; the tool description marks it as third-party content.
- A real-composition test proves that `setIndexes` persists through the profile without remounting the service, and unit tests cover fetch limits, cache sharing, removal, and search matching, ordering, and paging.
