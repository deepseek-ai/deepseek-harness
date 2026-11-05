---
description: "Enable the Connectors tab of the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-connectors-bundle

English | [中文](README.zh.md)

## Summary

Enable Connectors to add a Connectors tab beside Installed on the Web or Desktop Plugins page. The tab lists the official connectors with their switches, installs a missing one when it is switched on, and opens an installed one's page, where its account is connected. The connectors run only while the bundle is enabled; switching it off stops every connector. Shipped profiles leave the bundle disabled, and the Plugins page does not list it until it is enabled.

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

In **Plugins → Add plugin**, enter `@deepseek-ai/dsh-experimental-connectors-bundle`, choose **Install**, then **Enable now**. DSH uses the shipped copy without downloading another one. Alternatively, add the name to `dsh.profile.bundles` in the target [profile](../../boot/app-boot/README.md#profiles)'s `package.json`. The Connectors tab then appears beside Installed, and switching the bundle off hides its card again. Each tab row shows the switch the connector's card would show; switching on a missing connector installs it at the running DSH version. An installed connector's name opens its page, and that page's Back button returns to the tab. The connectors never appear on Installed. Switching the bundle off removes the tab and stops every connector; switching it on again resumes them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The bundle patch inserts one browser row, [client-ui-connectors](../client-ui-connectors/README.md), which owns the connector list, its copy, and the tab.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Connectors tab](../client-ui-connectors/README.md) · [Plugins page](../../client/ui-plugin-manager/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the connector bundles the tab installs; each installed connector owns its tools, skills, and runtime context, and the tab adds none.

#### KV Cache effect

Installing or switching on a connector changes later requests as that connector documents; the tab itself adds no model context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Installing from the tab needs the connector package published at the running DSH version; a development build installs connectors with `dsh plugin add` instead.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
