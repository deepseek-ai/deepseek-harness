---
description: "Synthesize speech with the DeepSeek speech synthesis API, authenticated by the DeepSeek account or API key."
kind: "package-reference"
---

# @deepseek-ai/dsh-text-to-speech-deepseek

English | [中文](README.zh.md)

## Summary

This provider registers `deepseek-tts` with `text-to-speech` and sends each text to the DeepSeek speech synthesis API, `POST /v1/tools/tts`, which streams 24 kHz 16-bit mono PCM back. [`ctx.deepseekAuth`](../../account/deepseek-auth/README.md) authenticates each request with the DeepSeek account sign-in or, without one, the DeepSeek API key. Activation sends no text and contacts no service.

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

The [read-aloud bundle](../read-aloud-bundle/README.md) enables this row. The provider offers the voices `stella` (the default, a female voice) and `tide` (a male voice); `text-to-speech` chooses between them for each request. `idleTimeoutMs` (30,000) is the longest wait for the next audio bytes while a consumer is asking, the first bytes included. `providerId` (`deepseek-tts`) is the registration id that `text-to-speech` selects.

The provider asks `ctx.deepseekAuth` for the account sign-in first and for the API key second, both bound to `/v1/tools/tts` under the origin of that credential's deployment. It is `ready` while either credential is configured and `unavailable` with `sign-in-required` while neither is. A deployment whose base URL points at a service without `/v1/tools/tts` fails each request as `service-unavailable`.

The API bills each request by the characters submitted, where a Chinese character counts two, and accepts at most 10,000 such units per request, so the provider declares `maxCharacters: 5000`. The bundle details link DeepSeek's speech synthesis guide, which states the prices, in the UI language.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

Each request carries `text`, `voice_id`, `format: "pcm"` and `filter_markdown: false`; the caller sends text that is already plain. Requests refuse redirects, and no request is retried, because every submitted character is billed.

HTTP 401 is classified from the status alone: an account sign-in is invalidated through the authorization's `reject()` and the failure is `sign-in-required`; an API key fails as `api-key-invalid`. 400 and 413 map to `text-rejected`, 402 to `quota-exceeded`, 404 to `service-unavailable`, 408 and 504 to `timeout`, 429 and 503 to `rate-limited`, and any other status to `service-error`. A JSON body under status 200 is an error report. The service's error message is kept up to 200 characters from a body of at most 16 KiB.

Audio already yielded stays valid when a later pull fails. A body read that fails is `service-error`, a reply without audio is `service-error`, and a request that received no response is `service-unavailable`. The idle interval runs only while a pull is waiting, so a consumer that plays slower than synthesis does not time the request out. An account sign-out ends the request as `sign-in-required`, and the caller's cancellation ends it with the caller's reason. Failures log the endpoint path, status and the service's message with the `[text-to-speech-deepseek]` prefix, never the text or credentials.

Availability is re-inspected when a credential record or reference changes and when the account service is mounted or removed; the latest inspection wins, and disposal stops publication.

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

- A reply that ends cleanly before all audio was sent cannot be told from a complete one, because the PCM stream carries no length. The service detects the language from the text and accepts no language choice. Speech rate cannot be changed.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

Tests run against `tests/service-double.ts`, a loopback double, with the real `DeepSeekAuth`. No test calls the production API. On 2026-11-23 the production endpoint answered an invalid `x-dsh-auth-token` as an invalid account token and a missing credential as a missing key, so it recognizes both credential kinds; a synthesis with a valid credential was not run from this repository.

</details>
