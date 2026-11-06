---
description: "List, install, and open the official connectors from a Plugins page tab."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-connectors

English | [中文](README.zh.md)

## Summary

The Connectors tab of the Plugins page lists the official connectors with their brand icons and the Installed list's switch. Turning a missing connector on installs it at the running DSH version and switches it on; an installed connector's row opens its page, as a card on the Installed list does. The Installed tab's card lists leave the connectors to this tab, and switching the Connectors bundle off stops every connector.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable the [Connectors bundle](../connectors-bundle/README.md). This package has no configuration fields. Each row shows the connector's brand icon, title, and description in the interface language, and the switch its card would show on the Installed list. Turning on a connector the profile does not hold opens the install dialog at the running DSH version, switches the connector on once installed, and shows its account guidance on this tab; a build that carries no DSH version shows no switch for it. A connector runs only while the bundle is enabled; switching the bundle off stops every connector and keeps each connector's own switch, and switching it back on resumes them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host entry provides the `connectors` service while the bundle is enabled. A connector row that declares `inject: [connectors]` stays pending without it, so the Loader stops and resumes the connectors with the bundle's switch wherever it changes. The browser entry registers the tab into `plugins.tab`. `ConnectorsController` reads `pluginManager.listBundles` when the tab first renders and again on `plugin-manager/changed` and `connection/reset`; only the latest read publishes. Each row renders the page's `renderEnableSwitch`, with the install target `<package>@<DSH_CLIENT_VERSION>` for a missing connector, and an installed connector's name button, stretched over its row, calls `openPackage`. Each connector's brand icon is a copy of the `icon.svg` its bundle declares, under `src/client/assets/`. The connector list is `CONNECTOR_BUNDLES` from [`dsh-official-bundles`](../../util/official-bundles/README.md), which the Plugins page also keeps off its card lists; each connector's title, description, and icon live in this package, so the tab shows connectors the profile does not hold.

- [Host source](src/index.ts)
- [Browser source](src/client/index.ts)
- [Tests](tests/)

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connectors bundle](../connectors-bundle/README.md) — the optional bundle that enables this tab.
- [Plugins page](../../client/ui-plugin-manager/README.md) — page tabs, the install dialog, and the card lists that leave the connectors to this tab.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the connector bundles its Install adds; each installed connector owns its model-facing contributions, and the tab adds no tools or prompt content.

#### KV Cache effect

The tab adds no model context. An installed or switched-on connector changes later requests as that connector documents, and switching the bundle off removes every connector's contributions from later requests until it is switched back on.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The list names only connectors that DSH releases; a new connector adds its package name to `CONNECTOR_BUNDLES`, its copy and icon here, and `inject: [connectors]` to its row.
- Rows show no account connection state; the connector's page shows it.
- Installing needs the connector package published at the running DSH version.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
