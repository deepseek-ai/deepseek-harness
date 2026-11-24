# Agent Note: Connectors tab for the official connectors

Status: implemented

English | [中文](2026-11-01-connectors-tab.zh.md)

## Problem

The official connector bundles, such as Feishu, WeCom, Notion, Tencent Docs, and Linear, are separately installed packages. Before installation the Plugins page shows nothing about a connector. Users need one place that offers every official connector, installs a missing one, and leads to the connector's own page, where its account section lives.

## Decision

The experimental optional [Connectors bundle](../../../../packages/experimental/client-ui-connectors/README.md) is off by default, and the Plugins page lists it under Experimental plugins. One package holds the bundle declaration and the tab, because the bundle composes nothing else: its patch inserts its own row, whose browser entry registers the Connectors tab through `plugins.tab`. The entry is a tab rather than a bundle detail page because only a tab's owner props carry `install` and an `openPackage` whose page returns to the tab; the plugin manager keeps no navigation stack for a page opened from another bundle's page.

The tab uses the Plugins page as the Discover tab does and changes neither the page nor the shared bundle lists. It carries the connector list, each connector's title and description in every shipped language, and its brand icon. A connector the profile does not hold shows **Install**, which passes `<package>@<DSH_CLIENT_VERSION>` to the page's install dialog; an installed connector shows a switch, which the tab applies through `pluginManager.setBundleEnabled`, and the rest of its row opens its page. The connector packages stay separately installed and do not join `ON_DEMAND_BUNDLES`, so removing the experiment leaves every connector installable with `dsh plugin add`.

Installed connectors keep their cards and switches on the Installed tab and run whether or not the Connectors bundle is enabled; the bundle adds only the tab.

## Alternatives considered

**Leaving the connectors off the Installed lists.** With the tab as the connectors' only entry, each connector appears once. It needs a connector list shared with the Plugins page and a filter in that page's card lists, so an experimental tab changes what the page shows. The existing lists do not fit either: `HIDDEN_BUNDLES` also removes the detail pages that carry the account sections, `listedByDefault: false` still lists installed bundles, and `MORE_BUNDLES` applies only to official bundles.

**One switch that stops every connector.** A Host service that every connector row injects lets the bundle's switch stop and resume the connectors. Every connector then runs only while an experimental bundle is enabled, in every profile, including those without a Plugins page. A row condition (`disabled: !!js`) cannot follow the switch, because the Loader evaluates it only when it mounts the row, and disabling the connectors from the Plugins page covers only that page's switch and overwrites each connector's own enabled state.

**The Installed list's switch in each row.** A switch that installs a missing connector and then switches it on needs a new Factory slot and an install-then-enable path in the Plugins page. The tab's own switch covers installed connectors through `pluginManager.setBundleEnabled` without either, and the install dialog's **Enable now** switches a newly installed connector on.

**Official on-demand catalog entries for the connectors.** The catalog supplies offline metadata, detail pages before installation, and development `link:` installs. It also makes every connector an official catalog member that requires an icon, and lists uninstalled connectors in the Plugins page's own groups unless they are hidden as well.

**A detail page on the Connectors bundle card.** A `plugins.bundle.config` page cannot install a missing connector, a connector page opened from it returns to the main list, and the bundle's own rows and source sections stay below the content.

## Consequences

Installing from the tab needs the connector package published at the running DSH version; development builds install connectors with `dsh plugin add`. An installed connector appears on both the Installed tab and the Connectors tab, and the guidance it offers after **Enable now** appears on the Installed tab. A switch on the Connectors tab shows no account guidance or restart notice and sends no `plugin_toggle` event; the switch on the connector's Installed card does all three. A new official connector adds its package name, title, description, and icon to the tab; no check compares that copy with the connector's own. The tab shows no account connection state; the connector's page does.
