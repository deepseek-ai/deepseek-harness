---
description: "Expose bounded transient transcription through the authenticated Web Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-api-speech-to-text

English | [中文](README.zh.md)

## Summary

The `speech` Remote connects browser recordings to `ctx.speechToText`. It exposes provider discovery and one complete-recording transcription call.

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

Compose with the speech Service Definition and Typert. `maxAudioBytes` and `maxDurationSeconds` limit accepted recordings. The browser UI mounts this package’s generated `/remote` contribution when enabled.

`prepare(providerId, { downloadSource })` forwards one advertised source to the provider; omission keeps its configured policy. The catalog carries `downloadSources` for the picker. The provider rejects unavailable choices and changes to an active task’s source.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`catalog()` exposes provider identities, the default selection and recording limits. `transcribe()` validates canonical base64 and 16 kHz mono PCM16 WAV before resolving the selected provider. The existing gateway owns authentication and cancellation transport. Audio is transient, never a Session event or attachment; only the user’s later ordinary submission records recognized text. No runtime invariant companion is published because validation is stateless and preparation belongs to the provider.

`follow()` streams complete catalogs, including preparation states and current preferences. `prepare()` starts or joins a Host task; `cancelPreparation()` explicitly cancels it. `configure()` persists the supplied preference fields. A disconnected observer does not cancel preparation.

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

- No file upload, persistent transcript history or streaming protocol is exposed. Base64 adds transport overhead; recordings remain bounded by the advertised limits.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
