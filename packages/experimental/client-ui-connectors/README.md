---
description: "List, install, and open the official connectors from a Plugins page tab."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-connectors

English | [中文](README.zh.md)

## Summary

The Connectors tab of the Plugins page lists the official connectors with their titles and descriptions in the interface language. A missing connector's Install opens the page's install dialog at the running DSH version; an installed connector's button opens its page. The Installed tab's card lists leave the connectors to this tab, and switching the Connectors bundle off stops every connector.

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

Enable the [Connectors bundle](../connectors-bundle/README.md). This package has no configuration fields. Each row shows Install for a connector the profile does not hold, Installed for one that is switched off, and On for one that is switched on. Install is unavailable in a build that carries no DSH version. A connector runs only while the bundle is enabled; switching the bundle off stops every connector and keeps each connector's own switch, and switching it back on resumes them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host entry provides the `connectors` service while the bundle is enabled. A connector row that declares `inject: [connectors]` stays pending without it, so the Loader stops and resumes the connectors with the bundle's switch wherever it changes. The browser entry registers the tab into `plugins.tab`. `ConnectorsController` reads `pluginManager.listBundles` when the tab first renders and again on `plugin-manager/changed` and `connection/reset`; only the latest read publishes. Install calls the page's `install` with `<package>@<DSH_CLIENT_VERSION>`, and the button of an installed connector calls `openPackage`. The connector list is `CONNECTOR_BUNDLES` from [`dsh-official-bundles`](../../util/official-bundles/README.md), which the Plugins page also keeps off its card lists; each connector's title and description live in this package, so the tab shows connectors the profile does not hold.

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

- The list names only connectors that DSH releases; a new connector adds its package name to `CONNECTOR_BUNDLES`, its copy here, and `inject: [connectors]` to its row.
- Rows show no account connection state; the connector's page shows it.
- Installing needs the connector package published at the running DSH version.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
