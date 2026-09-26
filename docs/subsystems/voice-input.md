# Voice input

English | [中文](voice-input.zh.md)

Experimental speech recognition has three roles: the [Service Definition](../../packages/experimental/speech-to-text/README.md) routes named providers, the [SenseVoice provider](../../packages/experimental/speech-to-text-sensevoice/README.md) owns local inference, and the [Remote consumer](../../packages/experimental/api-speech-to-text/README.md) serves the browser. The [optional bundle](../../packages/experimental/voice-input-bundle/README.md) composes them with the microphone UI.

## Provider selection

`SpeechProviderId` brands the registration identity. `SpeechProviderInfo` carries a display name, accepted `languages` hints and `host-local` or `cloud` processing location. `SpeechRequest` contains WAV bytes and optional provider/language selection; `resolve()` produces `SpeechSpec` with one captured provider instance. A missing provider or unsupported language fails; replacement or withdrawal invalidates resolved work. Audio never falls back to a different provider.

`SpeechProvider.transcribe()` accepts one complete `SpeechInput` and an `AbortSignal`. `Transcript` returns plain `text`, `audioSeconds` and `inferenceSeconds`. Providers honor cancellation and settle their work before deregistration completes. The local provider serializes calls, bounds its queue and manages its worker lifetime independently of Sessions.

## Browser and Host ownership

The browser owns microphone tracks and the unsent draft. `TranscriptionRequest` sends canonical base64 PCM16 WAV through the authenticated Remote. `SpeechCatalog` advertises available providers, the default selection and recording byte/duration limits. The API validates this process input before recognition.

The input facade captures a revision-bearing selection before recording. `InputActions.insertText()` inserts one undoable plain-text edit only while the selection revision is current and submission permits editing. A rejected insertion leaves the transcript available for explicit insertion. Switching Sessions or disposing the plugin invalidates late results. Recognition itself writes no Session event; ordinary user submission owns the final model-visible text.

## Preparation and settings

`SpeechProviderInfo.downloadSources` advertises preparation origins. `SpeechPreparationOptions.downloadSource` selects one for a task; omission preserves provider policy. SenseVoice validates the advertised choice, pins a manual source without fallback, and rejects source changes during active preparation. The UI keeps a choice for retries in the current card; it is not a persisted recognition preference.

The Host provider owns one preparation task across page and Session changes. The Client shares one `follow()` subscription across the composer, setup prompt and bundle details. Optional `SpeechSetupEstimate` metadata supplies provider-specific planning hints, separate from measured progress. `SpeechPreparationStepKind` identifies ordered resource operations; `SpeechPreparationStep` records each status and start time. The complete `SpeechPreparationState` retains these steps after cancellation or failure. The collapsed UI shows the current operation; expanding lists all steps, with byte progress or elapsed time only for the running step. Closing an observer never cancels preparation. Verified files survive retries and idle worker reclamation.

Failed preparation can include `SpeechDownloadFailure` with the asset, source origin, classified reason and optional diagnostic code or HTTP status. The Client localizes recovery advice; raw download causes remain on the Host.

The microphone occupies `conversation.input.activity`, between the model selector and Send. Clicking starts capture and expands the toolbar; Stop transcribes and inserts into the draft. The activity preserves the editor and submit action, owns local feedback, and releases expansion on unmount. Cancel, Escape or hiding the page discards capture. Waveform history displays measured microphone amplitude. Bundle details contain recognition preferences, preparation state and progress. Explicit enablement uses `plugins.bundle.activation` to guide users with missing models to setup; the list shows only the bundle description and switch.

## Design rationale

The [voice input decision](../../.agents/notes/implemented/architecture/2026-09-16-experimental-voice-input.md) explains transient audio, explicit provider selection and lazy local preparation.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspeechcontroller--speechcontroller"></a>

### `ctx.speechController` — `SpeechController`

Speech calls never activate or submit to an Agent.

```ts cordis-catalog
/**
 * Read provider choices without preparing a recognizer.
 * @returns available providers, resolved default, and recording limits.
 */
@Remote catalog(): SpeechCatalog

/**
 * Follow provider readiness independently of Session and preparation lifetimes.
 * @param signal - Client observation lifetime.
 * @returns initial and subsequent complete readiness snapshots.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<SpeechCatalog>

/**
 * Persist the user's recognition preferences.
 * @param patch - changed preference fields.
 * @returns after preferences are saved.
 */
@Remote configure(patch: SpeechSelectionPatch): Promise<void>

/**
 * Start or join one Host-owned preparation task.
 * @param providerId - selected recognizer.
 * @param options - task-local source selection validated by the provider.
 */
@Remote prepare(providerId: SpeechProviderId, options?: SpeechPreparationOptions): void

/**
 * Explicitly cancel resource preparation.
 * @param providerId - selected recognizer.
 * @returns after the preparation task settles.
 */
@Remote cancelPreparation(providerId: SpeechProviderId): Promise<void>

/**
 * Validate and transcribe one recording through the explicit provider selection.
 * @param request - canonical WAV encoded as base64, provider id and language hint.
 * @param signal - Client cancellation or Remote contribution disposal.
 * @returns final transcript without adding a Session event.
 */
@Remote async transcribe(request: TranscriptionRequest, signal: AbortSignal): Promise<Transcript>
```

Source: [`packages/experimental/api-speech-to-text/src/index.ts`](../../packages/experimental/api-speech-to-text/src/index.ts)

<a id="ctxspeechtotext--speechtotext"></a>

### `ctx.speechToText` — `SpeechToText`

Registry shared by all transcription consumers in one Host composition.

```ts cordis-catalog
/**
 * Register one recognizer; duplicate ids fail without replacing the original.
 * @param provider - recognizer owned by the contributing fiber.
 * @returns idempotent disposer which rejects admission, cancels, and joins accepted work.
 */
register(provider: SpeechProvider): () => Promise<void>

/**
 * Read the current recognizer roster.
 * @returns available provider facts in registration order.
 */
listProviders(): readonly SpeechProviderInfo[]

/**
 * Observe complete readiness snapshots; a slow reader coalesces intermediate progress.
 * @param caller - observer lifetime, independent of any preparation task.
 * @returns an initial snapshot followed by the latest provider states.
 */
async *follow(caller: AbortSignal): AsyncIterable<SpeechSnapshot>

/**
 * Read provider readiness and current user preferences together.
 * @returns one detached complete observation.
 */
snapshot(): SpeechSnapshot

/**
 * Persist changed selection fields into this plugin's profile entry; the resulting language must be accepted by the selected provider.
 * @param patch - explicit provider or language changes.
 * @returns after the profile write and the live update it applies.
 */
async configure(patch: SpeechSelectionPatch): Promise<void>

/**
 * Start or join provider-owned preparation.
 * @param id - exact registered provider identity.
 * @param options - task-local source selection validated by the provider.
 */
prepare(id: SpeechProviderId, options?: SpeechPreparationOptions): void

/**
 * Explicitly cancel provider preparation without tying it to a browser connection.
 * @param id - exact registered provider identity.
 * @returns after the preparation task settles.
 */
async cancelPreparation(id: SpeechProviderId): Promise<void>

/**
 * Apply composition defaults and capture the selected provider. Missing providers and unsupported languages fail explicitly.
 * @param request - complete recording and optional selection.
 * @returns provider-pinned input for transcribe().
 */
resolve(request: SpeechRequest): SpeechSpec

/**
 * Execute exactly the resolved provider; no fallback sends audio elsewhere.
 * @param spec - resolved input; a withdrawn or replaced registration is rejected.
 * @param signal - caller cancellation.
 * @returns final transcript after provider settlement.
 */
async transcribe(spec: SpeechSpec, signal: AbortSignal): Promise<Transcript>
```

Source: [`packages/experimental/speech-to-text/src/index.ts`](../../packages/experimental/speech-to-text/src/index.ts)
<!-- END GENERATED cordis-surface -->
