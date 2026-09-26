---
description: "Named experimental transcription providers and cancellation ownership."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-speech-to-text

English | [中文](README.zh.md)

## Summary

This Service Definition selects named speech recognizers through `ctx.speechToText`. Consumers resolve their request before execution; providers register independently.

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

Load through the [voice input bundle](../voice-input-bundle/README.md), or compose the service with a provider and consumer. `defaultProvider` is required and selects an exact registered id; the bundle supplies `sensevoice-local`. `language` supplies the omitted language hint. A missing or duplicate provider fails explicitly.

Providers advertise preparation origins through `downloadSources`. `prepare(id, options)` forwards an optional `downloadSource` for one task; the provider validates the choice and refuses source changes during active preparation. Omission retains provider policy. Source choices are not persisted recognition preferences.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`resolve()` captures the provider instance, recording and language. `transcribe()` rejects a withdrawn or replaced registration. A registration disposer closes admission, aborts accepted requests and joins provider settlement; providers must honor cancellation. No fallback selects a different recognizer or uploads audio. No runtime invariant companion is published because the registry is the sole source of provider and preparation observations.

`defaultProvider` and `language` are volatile Config fields: `configure()` writes the supplied fields into this plugin's profile entry through the `settings` service, and the running instance reads the updated values without remounting; composition defaults apply until an override is saved. Settings addresses the entry by its configured id (`entry.options.id`), without the Loader's Include path. `configure()` fails without `settings` or a profile entry, and rejects a language unsupported by the selected provider before saving. Providers advertise accepted language hints through `languages`; `resolve()` validates the selected hint before transcription. Provider-owned preparation is observed through complete `SpeechSnapshot` values; closing an observer never cancels preparation.

The `./wave` helper validates canonical 16 kHz mono PCM16 WAV for the Remote consumer and the native recognition process. Both reject inconsistent headers and lengths before decoding samples.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Voice input subsystem](../../../docs/subsystems/voice-input.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as recordings and preparation remain outside model requests; ordinary user submission owns any later text.

#### KV Cache effect

No direct effect; ordinary submission owns the message content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only complete-recording transcription is supported. Streaming recognition and speech synthesis have no service methods.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
