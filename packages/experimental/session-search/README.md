---
description: "Give Agents tools to search and read earlier sessions from the current workspace."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-session-search

English | [中文](README.zh.md)

## Summary

Give every Agent five experimental read-only global tools to search earlier sessions. The content index opens on the first search and is shared by all Agents. The bundle ships switched off in Web and Desktop. Select it in Plugins to enable it.

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

In Web or Desktop, open Plugins and enable **Session search** in Official. Switch it off to remove its profile layer.

Enabling or disabling the bundle registers or removes its global tools in the running Host, so every Agent sees the change on its next request, in every preset including minimal.

This bundle enables Agent search tools. Sidebar search keeps its existing behavior.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the Host group `optional-session-search`, which registers the tools in the global tool layer. Later profile patches can override its rows by id. The [profile composer](../../boot/app-boot/README.md) owns patch ordering and errors.

The group owns an isolated `sessionQuery` provider with a lazy `:memory:` index, released when the bundle is switched off. The host's metadata service keeps `openAt: never`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Capability implementation](../tool-session-query/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [capability implementation](../tool-session-query/README.md), which owns model context and results.

#### KV Cache effect

The layer adds no request content directly; the capability implementation owns cache effects from tools, prompts, and results. Toggling the bundle changes the tool list of live Sessions, which invalidates their cached request prefix once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The bundle keeps one in-memory index after the first search. The index is rebuilt after restarting the application or switching the bundle off and on. Search remains restricted to authorized workspaces.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
