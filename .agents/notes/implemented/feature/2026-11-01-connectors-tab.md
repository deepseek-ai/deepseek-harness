# Agent Note: Connectors tab for the official connectors

Status: implemented

English | [中文](2026-11-01-connectors-tab.zh.md)

## Problem

The official connector bundles (Feishu, WeCom, DingTalk, Tencent Meeting, Notion, Tencent Docs, and Linear) are separately installed packages. Before installation the Plugins page shows nothing about a connector, and afterwards it lists the connector among all other installed bundles. Users need one place that offers every official connector, installs a missing one, and leads to the connector's own page, where its account section lives. Switching that place off switches every connector off.

## Decision

The experimental optional [Connectors bundle](../../../../packages/experimental/connectors-bundle/README.md), off by default and declaring `dsh.bundle.listedByDefault: false` so that the Plugins page lists it only once enabled, mounts the [Connectors tab](../../../../packages/experimental/client-ui-connectors/README.md) through `plugins.tab`. The entry is a tab rather than a bundle detail page because only a tab's owner props carry `install` and an `openPackage` whose page returns to the tab; the plugin manager keeps no navigation stack for a page opened from another bundle's page.

`CONNECTOR_BUNDLES` in [`dsh-official-bundles`](../../../../packages/util/official-bundles/README.md) names the connectors in the tab's order. The tab carries each connector's title and description in every shipped language and its brand icon, and shows the switch the connector's card would show, which the page renders through the tab's `renderEnableSwitch` owner prop; turning a missing connector on installs `<package>@<DSH_CLIENT_VERSION>` through the page's install dialog and switches it on. The connector packages stay separately installed and do not join `ON_DEMAND_BUNDLES`, so removing the experiment leaves every connector installable with `dsh plugin add`.

The Installed tab's card lists always leave the connectors out, and their detail pages open from the tab. The bundle's Host entry provides the `connectors` service, and each official connector's row declares `inject: [connectors]`, so the Loader keeps the connectors pending while the bundle is off. Switching Connectors off from the Plugins page, Settings, or the CLI stops every connector without changing the connector's own enabled state, and switching it on resumes them. Custom MCP servers stay in the MCP manager's settings and do not follow this switch.

## Alternatives considered

**A tab claim released with the tab.** `pluginNavigation.claim` took the connectors off the card lists only while the tab existed. Switching Connectors off then returned switched-on connectors to Installed and left them running, so the switch did not stop them.

**Switching the connectors off with the bundle.** The Plugins page could also disable the connectors when it disables the bundle. That covers only the page's own switch, reloads the Host once per connector, and overwrites each connector's enabled state. The bundle cannot do it itself, because its code unloads at that moment as it does on a restart.

**A row condition on the bundle selection.** `disabled: !!js` is evaluated only when the Loader decides whether to mount a row, and `profileContext.startedBundles` holds the selection at launch, so a row cannot follow a later switch.

**Official on-demand catalog entries for the connectors.** The catalog supplies offline metadata, detail pages before installation, and development `link:` installs. It also makes every connector an official catalog member that requires an icon, and lists uninstalled connectors in the Plugins page's own groups unless they are hidden as well.

**A detail page on the Connectors bundle card.** A `plugins.bundle.config` page cannot install a missing connector, a connector page opened from it returns to the main list, and the bundle's own rows and source sections stay below the content.

**Hiding connectors through the existing lists.** `HIDDEN_BUNDLES` also removes the detail pages that carry the account sections, `listedByDefault: false` still lists installed bundles, and `MORE_BUNDLES` applies only to official bundles.

## Consequences

Installing from the tab needs the connector package published at the running DSH version; development builds install connectors with `dsh plugin add`. A connector runs only while the experimental Connectors bundle is enabled, in every profile. A new official connector adds its package name to `CONNECTOR_BUNDLES`, its title, description, and icon to the tab, and `inject: [connectors]` to its row. The tab shows no account connection state; the connector's page does.
