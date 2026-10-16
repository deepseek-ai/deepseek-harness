---
description: "Enable experimental custom plugin markets from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-plugin-market-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle mounts custom plugin markets: the Host [`pluginMarket`](../../boot/plugin-market/README.md) service, which reads the plugin market indexes the user adds, and the Web [Discover tab](../../client/ui-plugin-market/README.md) of the Plugins page. Shipped profiles leave it disabled.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open **Plugins** in the Web sidebar, select **More** beside **Experimental plugins**, and switch on **Custom plugin markets**; once on, it also appears on the main list. The page then shows the **Installed** and **Discover** tabs; **Discover** adds index sources and installs their bundles. Switching the bundle off removes the Discover tab and the `plugin_market` tool; the saved index sources stay in the profile.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The static `cordis.patch.yml` inserts the `plugin-market` service row, disabled without a profile like `plugin-manager`, and the `ui-plugin-market` browser row. The Creator preset keeps its `tool-plugin-market` row; that plugin registers `plugin_market` only while `pluginMarket` is mounted, so the row neither waits nor shows the tool without this bundle. The Plugins page shows its tabs only when a `plugins.tab` entry exists, so it needs no knowledge of this bundle.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `pluginMarket` service: with the bundle switched on, the Creator preset gains the read-only `plugin_market` tool documented in [`dsh-plugin-market`](../../boot/plugin-market/README.md#model-experience).

#### KV Cache effect

Switching the bundle on or off adds or removes one tool schema in Creator sessions, which changes the cached request prefix of later requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- There is no official market; Discover lists only the index sources the user adds.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
