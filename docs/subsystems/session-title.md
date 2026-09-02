# Session Titles

English | [中文](session-title.zh.md)

Durable latest-wins title state and the optional asynchronous provider vocabulary owned by [`@deepseek-ai/dsh-session-title`](../../packages/session/session-title). The shared LLM helper owns the exact auxiliary request record. Package READMEs own timing, fallback, failure, and fork behavior; the generated [persistence catalog](../persistence-catalog.md) owns the complete event declarations.

Sources: [`packages/session/session-title/src/index.ts`](../../packages/session/session-title/src/index.ts), [`packages/session/session-title-llm/src/index.ts`](../../packages/session/session-title-llm/src/index.ts)

## Durable title state

`SessionTitleProviderId` is recorded for provider-produced revisions. `SessionTitleEventData` lists the exact human-message seqs used for the title, while `SessionTitleSnapshot` adds the durable event envelope facts returned by `ctx.sessionTitle.get()` and `foldSessionTitle()`. The `title` projection keeps its version-1 state and client view as only the title string or `null`, so existing persisted cache rows remain readable.

```ts type-equiv
/** Identifies one session-title provider registration. */
type SessionTitleProviderId = Branded<'SessionTitleProviderId'>
```

```ts type-equiv
/** Exact auxiliary model route that produced a title. */
interface SessionTitleModelProvenance {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
}
```

```ts type-equiv
/** Durable ownership record for an accepted session title. */
type SessionTitleSource =
  | { readonly kind: 'fallback' }
  | {
    readonly kind: 'provider'
    readonly provider: SessionTitleProviderId
    readonly model?: SessionTitleModelProvenance
  }
  | {
    /** Explicit user rename: pins the title — automatic generation stops scheduling. */
    readonly kind: 'user'
  }
```

```ts type-equiv
/** Payload of the log-only `session/title` event. */
interface SessionTitleEventData {
  /** Normalized non-empty title text. */
  readonly title: string
  /** Exact human `user/message` seqs used to derive this title; empty for an explicit user rename. */
  readonly messageSeqs: SessionSeq[]
  /** Whether the built-in fallback, a registered provider, or the user supplied the title. */
  readonly source: SessionTitleSource
}
```

```ts type-equiv
/** Latest folded title plus the title event's durable envelope facts. */
interface SessionTitleSnapshot extends SessionTitleEventData {
  /** Seq of the latest `session/title` event. */
  readonly eventSeq: SessionSeq
  /** Timestamp of the latest `session/title` event. */
  readonly updatedAt: number
}
```

## Auxiliary request record

The shared LLM helper records each validated, dispatchable title request before calling the model. The payload reproduces the model-visible system and message input, routing, output limit, provider ownership, and source-message attribution even when generation later fails.

```ts type-equiv
/** Exact model-visible request recorded before one auxiliary title dispatch. */
interface SessionTitleLlmRequestEventData {
  /** Registered title-provider identity responsible for the request. */
  readonly titleProvider: SessionTitleProviderId
  /** Exact human `user/message` seqs represented in `messages`. */
  readonly messageSeqs: SessionSeq[]
  /** Exact auxiliary LLM route. */
  readonly route: SessionTitleModelProvenance
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
}
```

## Provider input and output

The service snapshots eligible messages through one revision. A provider returns only seqs from that request; service-owned acceptance verifies ordering, normalizes the title, enforces the byte limit, and appends the title with its source-message seqs and source kind.

```ts type-equiv
/** One eligible human text message exposed to title providers. */
interface SessionTitleUserMessage {
  /** Source `user/message` event seq. */
  readonly seq: SessionSeq
  /** Exact concatenated text-block content. */
  readonly text: string
}
```

```ts type-equiv
/** Automatic generation cadence owned by a registered provider. */
type SessionTitleAutomaticMode = 'first-prompt' | 'all-prompts'
```

```ts type-equiv
/** Immutable input supplied to one title-provider call. */
interface SessionTitleProviderRequest {
  /** Live session being titled. */
  readonly session: Session
  /** All eligible human messages through this generation revision. */
  readonly messages: readonly SessionTitleUserMessage[]
  /** Exact current logged main-request route, when one has been recorded. */
  readonly route?: SessionTitleModelProvenance
  /** Cancellation for supersession, disposal, timeout composition, or the explicit caller. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Provider output before service-owned normalization and log acceptance. */
interface SessionTitleProviderResult {
  /** Proposed title text. */
  readonly title: string
  /** Exact seqs from `request.messages` used by this result. */
  readonly messageSeqs: readonly SessionSeq[]
  /** Auxiliary LLM route, when generation used a model. */
  readonly model?: SessionTitleModelProvenance
}
```

```ts type-equiv
/** One optional asynchronous title implementation registered with the service. */
interface SessionTitleProvider {
  /** Stable id of the provider recorded with the title. */
  readonly id: SessionTitleProviderId
  /** When new human prompts start automatic generation. */
  readonly automatic: SessionTitleAutomaticMode
  /**
   * Produce one title revision.
   * @param request - message snapshot, current route, session, and cancellation.
   * @returns proposed title plus exact input seqs and the optional provider/model route used to generate it.
   */
  generate(request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult>
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessiontitle--sessiontitleservice"></a>

### `ctx.sessionTitle` — `SessionTitleService`

Log-backed title fold plus asynchronous fallback generation.

```ts cordis-catalog
/**
 * Read the latest folded title from one live or replayed session.
 * @param session - session whose log is the title source of truth.
 * @returns latest title snapshot, or `undefined` before eligible input.
 */
get(session: Session): SessionTitleSnapshot | undefined

/**
 * Accept an explicit user title. Appends a `session/title` event with the
 * `user` source, which pins the title: in-flight automatic generation is
 * superseded and later user messages schedule none (an explicit
 * {@link SessionTitleService.refresh} remains the deliberate unpin).
 * @param session - exact live session to rename.
 * @param title - raw user input; normalized before acceptance.
 * @returns the accepted title snapshot.
 * @throws {SessionTitleInvalidError} when the title normalizes to empty.
 * @throws {Error} when the session is not live or the service is disposed.
 */
rename(session: Session, title: string): SessionTitleSnapshot

/**
 * Explicitly retry the registered provider, or materialize the built-in
 * fallback when no provider is registered.
 * @param session - exact live session to refresh.
 * @param signal - optional caller cancellation.
 * @returns latest accepted title, or `undefined` when no eligible text exists.
 */
async refresh(session: Session, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined>

/**
 * Register the sole optional title provider. Disposal aborts its pending and
 * active work before another provider may register.
 * @param provider - provider identity, cadence, and generation function.
 * @returns exact Cordis effect disposer, which settles after active calls quiesce.
 */
register(provider: SessionTitleProvider): () => Promise<void>
```

Types: [Session](session.md)

Source: [`packages/session/session-title/src/index.ts`](../../packages/session/session-title/src/index.ts)
<!-- END GENERATED cordis-surface -->
