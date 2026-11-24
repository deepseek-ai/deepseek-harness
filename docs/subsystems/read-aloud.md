# Read-aloud

English | [中文](read-aloud.zh.md)

Experimental read-aloud speaks a finalized assistant reply. It has three roles: the [Service Definition](../../packages/experimental/text-to-speech/README.md) routes text to a named synthesis provider, the [DeepSeek provider](../../packages/experimental/text-to-speech-deepseek/README.md) calls the cloud API, and the [Remote consumer](../../packages/experimental/read-aloud/README.md) plans and synthesizes replies for the browser. The [optional bundle](../../packages/experimental/read-aloud-bundle/README.md) composes them with the [message control](../../packages/experimental/client-ui-read-aloud/README.md).

## Synthesis providers

`SynthesisProviderId` brands a registration identity. `SynthesisProviderInfo` carries the display name, the `host-local` or `cloud` location, the sample rate of the provider's 16-bit mono PCM, `maxCharacters`, the longest text one call accepts, and `voices`, the ids of the voices it speaks with. `SynthesisRequest` holds the text and optionally a voice; `resolve()` applies the configured provider and the saved voice and returns a `SynthesisSpec` that captures that provider instance and the voice. A missing provider and a text over the limit fail explicitly, and no fallback sends text elsewhere.

`SynthesisProvider.synthesize()` receives the complete `SynthesisInput` and an `AbortSignal` and returns audio as an async iterable whose chunks split the byte stream anywhere. A provider reports a classified failure as `SpeechSynthesisError` with a `SynthesisFailureCode`. `SynthesisAvailability` is `ready`, `unavailable` with a reason, or `failed` with a Host diagnostic; `SynthesisSnapshot` pairs every provider's availability with the configured id. Withdrawing a registration aborts its streams and joins only the provider calls in flight.

## Pacing

The synthesis API bills every submitted character and synthesizes much faster than a voice reads, so read-aloud never submits text the listener has not reached. `ReadingPlan` lists a reply's segments as `ReadingSegment` ranges of its read-aloud text, each estimated at `segmentSeconds` of speech and closed at a sentence end. One `SegmentRequest` synthesizes one segment. The Client requests the next segment once the audio it holds has at most `dispatchBelowMs` left to play, and stopping cancels the request in flight. An early stop is therefore billed for the segments already requested and for nothing after them.

## Voices

A provider lists its voices, and the first is its default. `SynthesisSelectionPatch` saves one voice into the registry's profile entry, and `SynthesisProviderView` reports the voice that applies: the saved one while the provider offers it, else the default. The synthesis API detects the language from the text and has no speech rate, so neither is a choice.

While the configured provider is registered, `ReadAloudStatus` carries `SynthesisFacts`: the voices, the saved voice, and the sample rate. The bundle's details offer the voices from it and save a `VoiceSelection`. A `ReadingPlan` fixes the voice when it is made and every `SegmentRequest` repeats it, so one reading keeps one voice and a later choice applies to the next reading. A `SampleRequest` speaks a fixed sentence that the Host owns in one voice, so a listener can compare voices without reading a reply.

## Browser and Host ownership

The Host owns the text and the credentials. `ReadingTarget` names a Session and a message; the Host finds that assistant message in the stored Session log, reduces its Markdown to speech text, and segments it. The Client receives ranges and `AudioFrame` items of base64 PCM, never text, and the Host accepts only a range that is a segment of the named message. The controller keeps no reading state between calls.

The browser owns playback and pacing. One `AudioContext` per reading plays frames back to back, and its clock decides when the next segment is due. One reading runs at a time; leaving the Session stops its reading. Read-aloud appends no Session event and changes no model input.

`ReadAloudStatus` reports whether a reading can start. The message control is offered only while the state is `ready` and the current Peer may call the reading methods, which name their Session as the access resource.

## Failures

A failed segment ends the reading after the audio already received has played. The Client shows the failure class in a toast. After a failure that may pass, the next click on the same reply continues at the failed segment, so audio that was already heard is not synthesized again. A range that is no longer a segment of the message, or a voice the provider no longer offers, as after a configuration change, is refused as `readAloud/stale-plan`.

## Design rationale

The [segment pacing decision](../../.agents/notes/implemented/feature/2026-11-23-read-aloud-segment-pacing.md) explains why pacing is by segment, why the browser drives it, and why the Host converts Markdown itself.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxreadaloud--readaloudcontroller"></a>

### `ctx.readAloud` — `ReadAloudController`

Read-aloud calls never activate, read from, or submit to an Agent, and append no Session event.

```ts cordis-catalog
/**
 * Follow whether a reading can start and which voices exist, so the Client offers the action only while it can and
 * shows the saved voice.
 * @param signal - Client observation lifetime.
 * @returns the current status, then each change of it.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<ReadAloudStatus>

/**
 * Save the voice that readings started afterwards use.
 * @param selection - one of the voices `follow()` reports.
 */
@Remote async configure(selection: VoiceSelection): Promise<void>

/**
 * Locate one finalized assistant message and cut its readable text into segments.
 * @param target - Session and message to read.
 * @param signal - Client cancellation.
 * @returns the message's log position, its segments, the voice, and the pacing and audio facts; no text leaves the Host.
 */
@Remote({ resources: { session: target => target.sessionId } }) async plan(target: ReadingTarget, signal: AbortSignal): Promise<ReadingPlan>

/**
 * Synthesize one planned segment in the plan's voice. The range must be a segment of the message under the current
 * configuration, so a Client cannot have other text spoken.
 * @param request - message position, one segment of its plan, and the plan's voice.
 * @param signal - Client cancellation; it ends the provider request.
 * @returns frames of whole PCM samples in playback order.
 */
@Remote({ mode: 'stream', resources: { session: request => request.sessionId } }) async *synthesize(request: SegmentRequest, signal: AbortSignal): AsyncIterable<AudioFrame>

/**
 * Speak the Host's sample sentence in one voice, so a listener can choose between voices.
 * @param request - voice to hear and the language of the sentence.
 * @param signal - Client cancellation; it ends the provider request.
 * @returns frames of whole PCM samples in playback order, at `SynthesisFacts.sampleRate`.
 */
@Remote({ mode: 'stream' }) async *sample(request: SampleRequest, signal: AbortSignal): AsyncIterable<AudioFrame>
```

Source: [`packages/experimental/read-aloud/src/index.ts`](../../packages/experimental/read-aloud/src/index.ts)

<a id="ctxtexttospeech--texttospeech"></a>

### `ctx.textToSpeech` — `TextToSpeech`

Registry shared by all synthesis consumers in one Host composition.

```ts cordis-catalog
/**
 * Register one synthesizer; a duplicate id fails without replacing the original.
 * @param provider - synthesizer owned by the contributing fiber.
 * @returns idempotent disposer which rejects later pulls, cancels, and joins provider calls in flight.
 */
register(provider: SynthesisProvider): () => Promise<void>

/**
 * Read provider availability, the configured selection, and the voice preference together.
 * @returns one detached complete observation.
 */
snapshot(): SynthesisSnapshot

/**
 * Persist the voice preference into this plugin's profile entry. The configured provider must be registered and
 * offer the voice.
 * @param patch - voice that later syntheses use when they name none.
 * @returns after the profile write and the live update it applies.
 */
async configure(patch: SynthesisSelectionPatch): Promise<void>

/**
 * Observe complete snapshots; an observer that falls behind receives only the latest one.
 * @param caller - observer lifetime.
 * @returns an initial snapshot followed by one per change, ending when the observer or the service stops.
 */
async *follow(caller: AbortSignal): AsyncIterable<SynthesisSnapshot>

/**
 * Apply the configured provider and the voice preference, and capture both. A missing provider, a text over the
 * provider's limit, and a named voice the provider does not offer fail explicitly.
 * @param request - complete text to speak and optionally its voice.
 * @returns provider-pinned input for synthesize().
 */
resolve(request: SynthesisRequest): SynthesisSpec

/**
 * Speak through exactly the resolved provider; no fallback sends text elsewhere. A stream nobody pulls holds no
 * provider call: withdrawal aborts the provider's signal and joins only calls in flight.
 * @param spec - resolved input; a withdrawn or replaced registration is rejected.
 * @param signal - caller cancellation.
 * @returns the provider's audio; pulls after cancellation or withdrawal reject.
 */
synthesize(spec: SynthesisSpec, signal: AbortSignal): AsyncIterable<Uint8Array>
```

Source: [`packages/experimental/text-to-speech/src/index.ts`](../../packages/experimental/text-to-speech/src/index.ts)
<!-- END GENERATED cordis-surface -->
