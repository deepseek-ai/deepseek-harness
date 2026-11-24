---
description: "Enable experimental read-aloud of assistant replies with DeepSeek cloud speech synthesis."
kind: "package-bundle"
---

# @deepseek-ai/dsh-read-aloud-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle adds a Read aloud control under assistant replies. It composes the [synthesis registry](../text-to-speech/README.md), the [DeepSeek cloud synthesizer](../text-to-speech-deepseek/README.md), the [read-aloud Remote](../read-aloud/README.md) and the [browser control](../client-ui-read-aloud/README.md). Reading uses DeepSeek cloud speech synthesis, which is billed per submitted character to the DeepSeek account or API key.

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

Turn the bundle on in **Plugins**. With a DeepSeek account sign-in or a DeepSeek API key, a speaker control appears under each finished assistant reply; without either, the bundle's details explain what is missing and offer sign-in. The details open with a feature preview: a reply, its action row with the read-aloud control highlighted, and the speech it becomes.

A reply is submitted for synthesis one segment at a time as playback advances, so a reading stopped early is billed only for the segments already requested. The `read-aloud` row sets the segment length (`segmentSeconds`, 30) and when the next segment is requested (`dispatchBelowSeconds`, 15); the voice is chosen in the bundle's details and saved in the `text-to-speech` row (`voice`, `stella` or `tide`).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`cordis.patch.yml` inserts four rows: `text-to-speech` with `defaultProvider: deepseek-tts`, `text-to-speech-deepseek`, `read-aloud`, and `ui-read-aloud`. The package entry exports nothing at runtime.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Read-aloud subsystem](../../../docs/subsystems/read-aloud.md) · [Segment pacing decision](../../../.agents/notes/implemented/feature/2026-11-23-read-aloud-segment-pacing.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the composed plugins read stored replies and play transient audio outside model requests.

#### KV Cache effect

No effect; no model request, message, or Session event changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- DeepSeek cloud synthesis is the only provider, so reading needs a DeepSeek credential and a network connection. Code blocks, tables, and formulas are not read; the Plugins page does not say so.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

`apps/web/tests/read-aloud.e2e.ts` enables the bundle on the shipped Web composition and reads a seeded reply against a loopback synthesis double.

</details>
