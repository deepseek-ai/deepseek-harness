# Agent Note: DeepSeek cloud speech recognition with automatic selection

Status: implemented

English | [中文](2026-11-04-deepseek-cloud-speech-recognition.zh.md)

## Problem

Experimental voice input recognized speech only on the Host, so first use required downloading and preparing local models. Signed-in DeepSeek users should dictate without that setup, while signed-out users keep the local option. The [voice input decision](../architecture/2026-09-16-experimental-voice-input.md) forbids silently changing where recordings are processed and any fallback that uploads speech after a local failure.

## Decision

A separate provider package, `speech-to-text-deepseek`, registers `deepseek-asr` with `location: 'cloud'` and sends complete recordings to the One-Shot endpoint as raw PCM. It does not use the streaming WebSocket endpoint. It authenticates like the account model route, sending the token the account service releases for the endpoint, and refuses recordings without a stored DeepSeek account. The account service releases tokens to its `harnessOrigin`, by default `https://harness.deepseek.com`, the default endpoint origin, but never loopback-issued grants to that official origin.

`speech-to-text` gains the `auto` preference and `autoOrder`. Selection happens before recording: the first registered provider that is not `unavailable` wins, and the Client sends that exact provider id with the recording. A failed recognition never re-routes audio, and signing out during a recording fails that recording rather than switching providers. One saved language serves every provider: a provider that does not list it receives `auto`, so the menu offers every language some provider recognizes and notes when the provider in use detects instead. The cloud provider sends the language as `preferred_language` and the UI language as `x-client-locale`, as the voice settings RFC specifies.

Signed-in users get cloud recognition by default without an upload prompt; the user agreement and privacy policy disclose processing, and the interface names the location in the tooltip, transcription status and bundle details. The microphone stays visible whenever the plugin is enabled. Signing in uses a new optional Client service, `accountSignIn`, so the voice UI reuses the account dialog and browser flow instead of duplicating them. After sign-in the dialog closes and the user starts recording; recording never starts without a click because the sign-in tab takes focus and blur cancels capture.

## Alternatives considered

A first-use upload notice was rejected by product because the user agreement covers it. Falling back to cloud recognition after a local failure would violate the existing no-fallback guarantee. Calling `account.startSignIn` from the voice UI would duplicate the sign-in dialog, tab ownership and failure states. Limiting the menu to the languages of the provider in use was rejected: the saved language would appear reset whenever automatic selection switched providers.

## Consequences

The shipped bundle enables the cloud row against the production endpoint. Raw PCM is zero-padded to 32 bytes because the service rejects other lengths, adding at most 1 ms of silence. A rejected account token signs the account out. Verification covers automatic routing and language rules, account authentication and token rejection, retries with a stable `audio_id`, and a real-composition browser sign-in and dictation against a loopback service.
