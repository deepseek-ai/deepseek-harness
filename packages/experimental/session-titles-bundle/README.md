---
description: "Refresh session titles as new human prompts arrive."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-session-titles-bundle

English | [中文](README.zh.md)

## Summary

Generate experimental session titles from the conversation's eligible human prompts. This replaces the first-prompt title provider and applies across presets. It ships switched off in Web and Desktop. Select it in Plugins to enable it.

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

In Web or Desktop, open Plugins and enable **Conversation-following titles** in Official. Switch it off to remove its profile layer.

The switch changes the title provider for existing and new Sessions. Eligible human prompts or explicit refresh trigger title requests; the model is asked to keep an existing generated title exactly while it still describes the main topic or task. Automatic updates preserve user-pinned titles. Agent tool catalogs remain unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) contributes the provider on the host. Later profile patches can override its settings. The [profile composer](../../boot/app-boot/README.md) owns patch ordering and errors. The layer disables `session-title-llm` before selecting its replacement; deselection restores the default provider.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Capability implementation](../session-title-all-prompts-llm/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [capability implementation](../session-title-all-prompts-llm/README.md), which owns model context and results.

#### KV Cache effect

The layer adds no request content directly; the capability implementation owns cache effects from tools, prompts, and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Automatic title failures retain the previous title. The 4096-byte title-input budget includes the current generated title when supplied and rejects oversized input instead of truncating conversation history.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
