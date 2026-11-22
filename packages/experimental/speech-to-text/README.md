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

Load through the [voice input bundle](../voice-input-bundle/README.md), or compose the service with a provider and consumer. `defaultProvider` is required and selects an exact registered id, or `auto`; the bundle supplies `auto` with `autoOrder: [deepseek-asr, sensevoice-local]`. Automatic selection takes the first registered `autoOrder` provider that records without preparation (`ready`, `standby` or `waking`), otherwise the first one that is neither `unavailable` nor `failed`, otherwise the first registered one so that its state explains the refusal; the choice is made before recording and never replaces a provider after a failure. `language` supplies the omitted language hint, and a provider that does not list it receives `auto`, so one saved hint serves every provider. A requested hint must be listed by at least one registered provider; a saved hint that no registered provider lists, as after its provider is removed, is reported and used as `auto`. Every provider must list `auto`. A missing or duplicate provider, an `auto` preference without `autoOrder`, and a provider registering the reserved id `auto` fail explicitly.

Providers advertise preparation origins through `downloadSources`. `prepare(id, options)` forwards an optional `downloadSource` for one task; the provider validates the choice and refuses source changes during active preparation. Omission retains provider policy. Source choices are not persisted recognition preferences.

Providers publish readiness as `SpeechPreparationState`; `unavailable` with `sign-in-required` marks a provider that refuses recordings until the user signs in to DeepSeek or configures a DeepSeek API key. Expected recognition failures throw `SpeechTranscriptionError`, whose `SpeechFailureCode` Consumers localize; its message stays a Host diagnostic.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`resolve()` captures the provider instance, recording and language. `transcribe()` rejects a withdrawn or replaced registration. A registration disposer closes admission, aborts accepted requests and joins provider settlement; providers must honor cancellation. No fallback selects a different recognizer or uploads audio.

`defaultProvider` and `language` are volatile Config fields: `configure()` writes the supplied fields into this plugin's profile entry through the `settings` service, and the running instance reads the updated values without remounting; composition defaults apply until an override is saved. Settings addresses the entry by its configured id (`entry.options.id`), without the Loader's Include path. `configure()` fails without `settings` or a profile entry, and rejects, before saving, a language no registered provider lists. Providers advertise accepted language hints through `languages`; `resolve()` validates the selected hint before transcription. Provider-owned preparation is observed through complete `SpeechSnapshot` values; closing an observer never cancels preparation.

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
