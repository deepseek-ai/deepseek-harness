---
description: "Show a temporary 1017 badge beside DeepSeek Flash in the composer model selector."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-deepseek-model-label-1017

English | [中文](README.zh.md)

## Summary

This package shows `1017` beside `DeepSeek-V4.1-Flash` in the composer model selector. It covers the official API-key and account routes while preserving their catalog names and request IDs. Disable it to restore plain model names.

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

The Web bundle includes this plugin, including when Desktop uses that bundle. It has no configuration fields.

The badge appears only when the provider is `deepseek-official` or `deepseek-account`, the model ID is `deepseek-flash`, and the catalog name is exactly `DeepSeek-V4.1-Flash`. Other names and providers keep their catalog text. The input button, current-model menu row, and model options share the badge.

Disable the following row through a profile patch to restore the catalog name:

```yaml
- id: ui-deepseek-model-label-1017
  disabled: true
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser entry contributes to the existing `conversation.input.model.label` slot through `ctx.slots.inject()`. Its component derives the label from owner props and uses the shared `Tag` primitive; it owns no cache, subscription, network request, or model-selection state. Registration and dictionaries leave with the plugin. The Host entry only makes the browser package available to the Loader.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These packages own the selector and its two directory sources.

- [Model selection](../ui-model-selection/README.md) — label placement and selection behavior.
- [DeepSeek transport](../../llm/llm-deepseek/README.md) — built-in model catalog.
- [DeepSeek account](../../llm/llm-deepseek-account/README.md) — account-provided model directory.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package only decorates browser labels without changing model requests or Session events.

#### KV Cache effect

None; provider requests and their cached prefixes are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The fixed release marker has these presentation limits:

- The settings editor, `/model` command, trigger accessibility text, and existing tooltip keep the original catalog name.
- This package occupies a `single` slot. Another model-label plugin at the same priority conflicts; the two presentations do not compose automatically.
- The `1017` marker is fixed client presentation, not a server capability assertion. Remove this package and its bundle row when structured release labels replace it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
