---
description: "Enable the Connectors tab of the Plugins page to list, install, and open the official connectors."
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-connectors

English | [中文](README.zh.md)

## Summary

Enable Connectors to add a Connectors tab beside Installed on the Web or Desktop Plugins page. The tab lists the official connectors with their brand icons, installs a missing one at the running DSH version, switches an installed one on or off, and opens its page, where its account is connected. Shipped profiles leave the bundle disabled, and the Plugins page lists it under Experimental plugins.

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

Open **Plugins** and switch on **Connectors** under **Experimental plugins**. Alternatively, add `@deepseek-ai/dsh-client-ui-connectors` to `dsh.profile.bundles` in the target [profile](../../boot/app-boot/README.md#profiles)'s `package.json`. The Connectors tab then appears beside Installed; switching the bundle off removes the tab. This package has no configuration fields.

Each row shows the connector's brand icon, title, and description in the interface language. A connector the profile does not hold shows **Install**, which opens the Plugins install dialog at its check screen with the connector's package at the running DSH version; the dialog offers **Enable now** once the installation finishes. A build that carries no DSH version shows no Install. An installed connector shows a switch that is on while the connector is enabled; the switch enables or disables the connector, as the switch on its Installed card does. The rest of the row opens the connector's page, and that page's Back button returns to the tab. When the Host does not apply a change, a line under the heading names the connector, and the switch shows the state the Host reports. Installed connectors keep their cards and switches on the Installed tab and run whether or not this bundle is enabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle patch inserts this package's own row. The Host entry is an empty plugin, and the browser entry registers the tab into `plugins.tab`. `ConnectorsController` reads `pluginManager.listBundles` when the tab first renders and again on `plugin-manager/changed` and `connection/reset`; only the latest read publishes. An installed connector's switch calls `pluginManager.setBundleEnabled` and stays disabled through the read that follows the write; a refused answer or a `failed` application names the connector in the failure line until another switch starts. **Install** calls the owner's `install` with the spec `<package>@<DSH_CLIENT_VERSION>`, and an installed connector's name button, stretched over its row, calls `openPackage`. Each connector's brand icon is a copy of the `icon.svg` its bundle declares, under `src/client/assets/`. The connector list and each connector's title, description, and icon live in this package, so the tab shows connectors the profile does not hold.

- [Bundle patch](cordis.patch.yml)
- [Host source](src/index.ts)
- [Browser source](src/client/index.ts)
- [Tests](tests/)

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Plugins page](../../client/ui-plugin-manager/README.md) — page tabs and the install dialog.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the connector bundles its Install adds and its switches enable or disable; each connector owns its model-facing contributions, and the tab adds no tools or prompt content.

#### KV Cache effect

The tab adds no model context. Installing a connector, or switching it on or off, changes later requests as that connector documents.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The list names only connectors that DSH releases; a new connector adds its package name, copy, and icon here. A row's title and description are this package's copy and must follow the connector's own display title; no check compares the two.
- Rows show no account connection state; the connector's page shows it. The account guidance a connector offers after **Enable now** appears on the Installed tab.
- Switching a connector on from the tab shows no account guidance, and a change that waits for a restart shows no restart notice; the switch on the connector's Installed card shows both. The tab's switch sends no `plugin_toggle` analytics event.
- Installing needs the connector package published at the running DSH version; a development build installs connectors with `dsh plugin add` instead.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
