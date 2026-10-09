---
description: "Offer the powered-by-DSH badge as a discoverable skill."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-badge-skill-bundle

English | [中文](README.zh.md)

## Summary

Offer the experimental DSH badge skill to Agents whose presets load skills. The shared provider adds no model tool. It ships switched off in Web and Desktop. Select it in Plugins to enable it.

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

In Web or Desktop, open Plugins and enable **DSH badge skill** in Official. Switch it off to remove its profile layer.

The switch adds or removes a Host-wide skill provider for existing and new Agents. Presets that expose skill loading can use the badge; minimal keeps its tool catalog unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) contributes the `skill-badge` provider row on the Host. Later root patches can disable that row; an override alone does not select the bundle. The [profile composer](../../boot/app-boot/README.md) owns patch ordering and errors.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Capability implementation](../skill-badge/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [capability implementation](../skill-badge/README.md), which owns model context and results.

#### KV Cache effect

The layer adds no request content directly; the capability implementation owns cache effects from tools, prompts, and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A preset must include skill discovery and loading to use the badge. The minimal preset does not gain skill tools from this bundle.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
