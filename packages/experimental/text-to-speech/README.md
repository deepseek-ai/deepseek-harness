---
description: "Route read-aloud text to a registered speech synthesis provider and stream its audio."
kind: "package-reference"
---

# @deepseek-ai/dsh-text-to-speech

English | [中文](README.zh.md)

## Summary

`ctx.textToSpeech` is the experimental registry of speech synthesis providers. A provider registers under an id with its audio format, its text limit, and its availability. A consumer resolves a text against the configured provider and pulls 16-bit PCM from it. The service synthesizes nothing itself and sends text to no provider other than the configured one.

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

The [read-aloud bundle](../read-aloud-bundle/README.md) enables this row with `defaultProvider: deepseek-tts`. `defaultProvider` is required and names the provider that speaks every request; a request made while that provider is not registered fails as `service-unavailable`.

A provider calls `register()` with its `info` (id, display name, `host-local` or `cloud`, the sample rate of its 16-bit mono PCM, and `maxCharacters`), an optional `availability` source, and `synthesize(input, signal)`. A consumer calls `resolve({ text })`, which captures the configured provider and rejects a text longer than its `maxCharacters`, then `synthesize(spec, signal)`, which returns the provider's audio as an async iterator. `snapshot()` and `follow(signal)` report every provider's availability with the configured id.

A provider reports a classified failure by throwing `SpeechSynthesisError` with one `SynthesisFailureCode`: `sign-in-required`, `api-key-invalid`, `rate-limited`, `quota-exceeded`, `service-unavailable`, `text-rejected`, `timeout`, or `service-error`. Consumers localize the code and keep the message as a Host diagnostic.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

A second registration of one id throws and leaves the first in place. The disposer `register()` returns is idempotent: it removes the provider, unsubscribes from its availability, aborts the signal every stream of that provider received, and waits for the provider calls in flight. A stream that nobody is pulling holds no provider call, so a consumer that stopped reading never delays withdrawal; its next pull rejects.

`synthesize()` checks the caller's signal and that the spec's provider is still the registered one before it calls the provider, and again around every pull. Returning the iterator early returns the provider's iterator.

`follow()` yields the current snapshot and then one per change. A follower that falls behind receives only the latest snapshot. The stream ends when the caller's signal aborts or the service is disposed.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Read-aloud subsystem](../../../docs/subsystems/read-aloud.md) · [Segment pacing decision](../../../.agents/notes/implemented/feature/2026-11-23-read-aloud-segment-pacing.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as synthesis reads text that was already produced and returns transient audio outside model requests.

#### KV Cache effect

No effect; no model request, message, or Session event changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- One configured provider speaks every request; there is no per-request provider choice and no fallback. Voices are a provider's own configuration, so the service lists none. Audio is 16-bit mono PCM only.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

`tests/service.spec.ts` covers registration lifetime, availability publication, routing refusals, and the join of a provider call in flight during withdrawal.

</details>
