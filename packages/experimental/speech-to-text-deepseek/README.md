---
description: "Recognize complete recordings with the DeepSeek One-Shot cloud service."
kind: "package-reference"
---

# @deepseek-ai/dsh-speech-to-text-deepseek

English | [中文](README.zh.md)

## Summary

This provider registers `deepseek-asr` with `speech-to-text` and sends each complete recording to the DeepSeek One-Shot transcription endpoint as raw 16 kHz mono PCM16. It authenticates with the signed-in DeepSeek account and accepts recordings only while an account is stored. Activation does not contact the recognition service.

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

The [voice input bundle](../voice-input-bundle/README.md) enables this row. `endpoint`, the complete transcription URL, defaults to `https://harness.deepseek.com/api/v0/asr/transcribe`. HTTPS is required; `allowLoopbackHttp: true` permits plain HTTP only to a loopback service double. The endpoint must not contain credentials, a query or a fragment. `timeoutMs` (30,000 ms), `maxRequestBytes` (3,932,160), `maxDurationSeconds` (120) and `maxResponseBytes` (65,536) bound one attempt.

Each request sends the token that the DeepSeek account service releases for `endpoint` as `x-dsh-auth-token`, like the account model route. The account service releases a token only for the origins it allows, including its `harnessOrigin`, `https://harness.deepseek.com` by default; a custom `endpoint` therefore needs a matching `harnessOrigin`; a stored account that receives no token for the endpoint reports failed readiness instead of a sign-in request. A rejection (HTTP 401, code 40002 or 40003) invalidates exactly that token, so the account signs out and the failure asks the user to sign in again.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

Readiness follows the account service's `watch()` stream; the latest inspection wins and disposal stops publication. Without an account service or a stored account the provider is `unavailable` with `sign-in-required`, which automatic selection skips. `prepare()` re-inspects; there is nothing to download or cancel.

A recording is validated as canonical WAV, stripped of its 44-byte header and zero-padded to a multiple of 32 bytes, at most 1 ms of silence, because the service rejects other raw PCM lengths. The multipart body carries `file`, `format=pcm` and a fresh `audio_id`; its complete length is checked before sending. `languages` (default `auto`, `zh`, `en`, `ja`, `es`, `fr`, `de`, `ru`, `pt`, `yue`, `ko`) lists the service's language codes and must include `auto`. A listed hint other than `auto` is sent as `preferred_language`; `auto` sends none. The client's UI language is sent as `x-client-locale` in the service spelling: hyphens become underscores and a bare `zh`, `en` or `pt` gains the region `CN`, `US` or `BR`. The service matches the two values. Requests refuse redirects, so tokens never follow a redirect.

The service deduplicates by `audio_id`, so the identical body is resubmitted once when no response arrives, on HTTP 5xx, or on `biz_code 3`. Other outcomes are final: `biz_data.code` 6 and 10 return empty text; 1, 2, 4, 7 and 8 map to `service-unavailable`, `rate-limited`, `invalid-audio` and `timeout`; 11 (`daily_limit_reached`, the daily recognition time allowance is used up) maps to `quota-exceeded`; HTTP 429 maps to `rate-limited`; other statuses, codes and malformed envelopes map to `service-error`. Failures throw `SpeechTranscriptionError` and log the endpoint path, status and codes with the `[speech-to-text-deepseek]` prefix, never audio, tokens or response bodies.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Voice input subsystem](../../../docs/subsystems/voice-input.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as recordings and transcription remain outside model requests; ordinary user submission owns any later text.

#### KV Cache effect

No direct effect; ordinary submission owns the message content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only One-Shot transcription of a complete recording is supported; the WebSocket streaming endpoint and `fetch_cached` are not used. Recordings must not exceed 120 seconds.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

Tests run against loopback service doubles: `tests/service-double.ts` for the provider and `apps/web/tests/voice-input-cloud.e2e.ts` for browser sign-in and dictation through the shipped composition. No test calls the production endpoint, because its account token comes only from an interactive browser sign-in.

</details>
