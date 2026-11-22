---
description: "Recognize complete recordings with the DeepSeek speech recognition API, authenticated by the DeepSeek account or API key."
kind: "package-reference"
---

# @deepseek-ai/dsh-speech-to-text-deepseek

English | [中文](README.zh.md)

## Summary

This provider registers `deepseek-asr` with `speech-to-text` and sends each complete recording to the DeepSeek speech recognition API, `/v1/tools/asr`. [`ctx.deepseekAuth`](../../account/deepseek-auth/README.md) authenticates each request with the DeepSeek account sign-in or, without one, the DeepSeek API key, so recordings are accepted while either is configured. Activation contacts no service.

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

The [voice input bundle](../voice-input-bundle/README.md) enables this row. It needs no configuration: the endpoint and the credential come from `ctx.deepseekAuth`, which every composition with a DeepSeek model route mounts. `timeoutMs` (30,000 ms) bounds the request including its response body; `maxRequestBytes` (8 MiB), `maxDurationSeconds` (120) and `maxResponseBytes` (65,536) bound one request.

The provider asks `ctx.deepseekAuth` for the account sign-in first and for the API key second, both bound to `/v1/tools/asr` under the origin of that credential's deployment: the account route's base URL and the account service's token for it, or the API-key route's base URL and key, `DEEPSEEK_API_KEY` at `https://api.deepseek.com` without that route. It is ready while either credential is configured and `unavailable` with `sign-in-required` while neither is. A deployment whose base URL points at a service without `/v1/tools/asr` fails each recording as `service-unavailable`. The billing order differs from the Search and Fetch APIs, which try the API key first outside a conversation.

Cloud recognition is billed by audio duration to the credential that authenticated the request; the bundle details link DeepSeek's speech recognition guide in the UI language.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

Readiness is re-inspected when a credential record or reference changes, when the account service is mounted or removed, and on `prepare()`; the latest inspection wins and disposal stops publication. A kind whose route settings do not resolve publishes `failed`, and a recording stops there as `service-error`, as `authorize()` does. There is nothing to download or cancel.

A recording is checked as canonical WAV no longer than `maxDurationSeconds` and no larger than `maxRequestBytes`, then sent unchanged as the single multipart field `file`. The body is encoded as bytes, not `FormData`, because undici's `FormData` pump rejects unhandled when an upload is cancelled early. The service detects the language itself, so the provider lists only `auto`. Requests refuse redirects.

The service has no idempotency key and bills by duration, so no request is retried. HTTP 401 is classified from the status before any body read: an account sign-in is invalidated through the authorization's `reject()` and the failure is `sign-in-required`; an API key fails as `api-key-invalid`, as an unusable configured key does. 400 and 413 map to `invalid-audio`, 402 to `quota-exceeded`, 404 and a request that received no response to `service-unavailable`, 408 and 504 to `timeout`, 429 and 503 to `rate-limited`, and other statuses or malformed bodies to `service-error`. An account sign-out during the request ends it as `sign-in-required`. Failures throw `SpeechTranscriptionError` and log the endpoint path, status and the service's message with the `[speech-to-text-deepseek]` prefix, never audio or credentials.

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

- Only one-shot transcription of a complete recording is supported; there is no streaming recognition and no language hint. Recordings must not exceed 120 seconds or 8 MiB. When the service rejects an account sign-in, it closes the connection before reading a full recording, so that rejection arrives as `service-unavailable` and the sign-in is not invalidated until a model request or a short request receives the HTTP 401.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

Tests run against loopback service doubles: `tests/service-double.ts` with the real `DeepSeekAuth` for the provider, and `apps/web/tests/voice-input-cloud.e2e.ts` for browser sign-in and dictation through the shipped composition. No test calls the production API, because its account token comes only from an interactive browser sign-in.

</details>
