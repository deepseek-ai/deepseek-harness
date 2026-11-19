---
description: "List, install, and open the official connectors from a Plugins page tab."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-connectors

English | [中文](README.zh.md)

## Summary

The Connectors tab of the Plugins page lists the official connectors with their brand icons. A connector the profile does not hold shows **Install**, which installs it at the running DSH version through the page's install dialog; an installed connector shows its state, and its row opens its page, as a card on the Installed list does.

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

Enable the [Connectors bundle](../connectors-bundle/README.md). This package has no configuration fields. Each row shows the connector's brand icon, title, and description in the interface language. A connector the profile does not hold shows **Install**, which opens the Plugins install dialog at its check screen with the connector's package at the running DSH version; the dialog offers **Enable now** once the installation finishes. A build that carries no DSH version shows no Install. An installed connector shows **Installed** or **On**; its row opens its page, and that page's Back button returns to the tab. Installed connectors keep their cards and switches on the Installed tab and run whether or not the bundle is enabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host entry is an empty plugin, and the browser entry registers the tab into `plugins.tab`. `ConnectorsController` reads `pluginManager.listBundles` when the tab first renders and again on `plugin-manager/changed` and `connection/reset`; only the latest read publishes. **Install** calls the owner's `install` with the spec `<package>@<DSH_CLIENT_VERSION>`, and an installed connector's name button, stretched over its row, calls `openPackage`. Each connector's brand icon is a copy of the `icon.svg` its bundle declares, under `src/client/assets/`. The connector list and each connector's title, description, and icon live in this package, so the tab shows connectors the profile does not hold.

- [Host source](src/index.ts)
- [Browser source](src/client/index.ts)
- [Tests](tests/)

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connectors bundle](../connectors-bundle/README.md) — the optional bundle that enables this tab.
- [Plugins page](../../client/ui-plugin-manager/README.md) — page tabs and the install dialog.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the connector bundles its Install adds; each installed connector owns its model-facing contributions, and the tab adds no tools or prompt content.

#### KV Cache effect

The tab adds no model context. An installed or switched-on connector changes later requests as that connector documents.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The list names only connectors that DSH releases; a new connector adds its package name, copy, and icon here. A row's title and description are this package's copy and must follow the connector's own display title; no check compares the two.
- Rows show no account connection state; the connector's page shows it. The account guidance a connector offers after **Enable now** appears on the Installed tab.
- Installing needs the connector package published at the running DSH version.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
