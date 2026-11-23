# Agent Note: DeepSeek cloud speech recognition with automatic selection

Status: implemented

English | [中文](2026-11-04-deepseek-cloud-speech-recognition.zh.md)

## Problem

Experimental voice input recognized speech only on the Host, so first use required downloading and preparing local models. Users with a DeepSeek credential should dictate without that setup, while users without one keep the local option. DeepSeek publishes speech recognition as `POST /v1/tools/asr`, which accepts the account sign-in and the API key like the other DeepSeek APIs, and [`ctx.deepseekAuth`](../architecture/2026-11-10-deepseek-request-authentication.md) owns how DeepSeek consumers authenticate. The [voice input decision](../architecture/2026-09-16-experimental-voice-input.md) forbids any fallback that uploads speech after a local failure.

## Decision

A separate provider package, `speech-to-text-deepseek`, registers `deepseek-asr` with `location: 'cloud'` and sends each complete WAV recording unchanged to `/v1/tools/asr`; there is no streaming. It is a `ctx.deepseekAuth` consumer that accepts both kinds and tries the account sign-in before the API key, because the account deployment is the official one unless a deployment overrides it, while an API key often belongs to a custom endpoint. It is ready while either credential is configured and probes no endpoint: a custom endpoint without `/v1/tools/asr` fails each recording. The account service and `deepseek-auth` are unchanged.

`speech-to-text` gains the `auto` preference and `autoOrder`. Selection happens before recording: the first provider that records without preparation wins, otherwise the first that is neither unavailable nor failed, and the Client sends that exact provider id with the recording. A failed recognition never re-routes audio, and signing out during a recording fails that recording rather than switching providers. One saved language serves every provider: a provider that does not list it receives `auto`. The service detects the language itself, so the cloud provider lists only `auto` and the menu notes that cloud recognition detects the language.

Users with a credential get cloud recognition by default without an upload prompt; the user agreement and privacy policy disclose processing, the interface names the location in the tooltip, transcription status and bundle details, and the details state the cost and link the speech recognition guide. This includes users of the earlier local default who have a credential: the product chose cloud recognition for them, which revises the voice input decision's requirement that later cloud providers not change where recordings are processed without a choice. The microphone stays visible whenever the plugin is enabled. Signing in uses a new optional Client service, `accountSignIn`, so the voice UI reuses the account dialog and browser flow.

## Alternatives considered

A first-use upload notice was rejected by product because the user agreement covers it. Falling back to cloud recognition after a local failure would violate the existing no-fallback guarantee. The earlier `harness.deepseek.com` endpoint was rejected because it accepted only the account sign-in and needed the account service to release tokens to a second origin. Probing each credential's endpoint before offering cloud recognition was rejected: a user who configures a custom endpoint owns that choice. An official-origin check in `ctx.deepseekAuth` was rejected because a custom gateway can serve Search while lacking speech recognition. Retrying a request was rejected because the service has no idempotency key and bills by duration. Calling `account.startSignIn` from the voice UI would duplicate the sign-in dialog, tab ownership and failure states.

## Consequences

The shipped bundle enables the cloud row, and the [upgrade guide](../../../../docs/upgrade-guide/v0.2.3-alpha.2/voice-input-cloud-default/guide.md) tells users how to keep local recognition. Outside a conversation the Search and Fetch APIs try the API key first while speech recognition tries the account sign-in first. HTTP 401 invalidates a rejected account sign-in, which signs the account out; when the service rejects an account sign-in it closes the connection before reading a full recording, so that rejection reaches the user as `service-unavailable` and the sign-in is invalidated by the next request that receives the 401. Verification covers automatic routing and language rules, both credential kinds and their order through the real `DeepSeekAuth`, status classification, and a real-composition browser sign-in and dictation against a loopback service.
