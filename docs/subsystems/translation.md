# Text translation

English | [中文](translation.zh.md)

The experimental [translator](../../packages/experimental/translator/README.md) translates text through anonymous browser endpoints or explicitly selected paid native Flash routes. Consumers own display, scheduling, and Session activation; Session-bound requests retain reusable results through an active Session writer.

## Requests and results

`TranslationProvider` selects `bing`, `google`, `deepseek-account` or `deepseek-official`. `TranslationRequest` supplies `text`, `targetLanguage`, and optional `sourceLanguage`, `provider` and branded `sessionId`. `resolve()` captures explicit routing in `TranslationSpec`: the configured provider defaults to Bing and omitted source language uses automatic detection. Common Chinese locale tags map to the selected provider's language codes. `translate()` returns plain text from the resolved provider.

The service exposes its configured `maxTextChars`, measured in UTF-16 code units. Consumers split longer inputs before requesting translation. Each call bounds the response bytes and includes the response-body read in its deadline. Caller cancellation and service disposal abort accepted requests; disposal waits for them to settle.

## Failures and data handling

`TranslationError` carries a `TranslationErrorCode` distinguishing text limits, HTTP failures, invalid responses, response limits, owned deadlines, and request failures. `TRANSLATION_SESSION_REQUIRED` rejects a missing persistence backend or Session; `TRANSLATION_SESSION_INACTIVE` rejects an uncached inactive Session before provider dispatch; `TRANSLATION_STORAGE_ERROR` rejects invalid saved records or failed durability. Provider diagnostics omit submitted text and response bodies. Failed calls do not select another provider. Responses are validated as external JSON and redirects are rejected.

`TRANSLATION_UNAVAILABLE` rejects a missing active built-in owner or registered route, unconfigured credentials, absent exact `deepseek-flash` catalog membership, an owner/model-list/official credential-reference change before dispatch, provider withdrawal, or a prepared call whose reasoning effort is not `off`. A native `finish` with reason `error` maps to `TRANSLATION_REQUEST_FAILED`; a missing or other non-`stop` finish maps to `TRANSLATION_INVALID_RESPONSE`.

Google receives source text in a form POST body; Bing receives it in a JSON POST body. Both are remote services. Their anonymous endpoints provide no supported developer availability or quota guarantee. Regional connectivity must be verified on the user's network.

## Persistent translations

Session-bound calls use `plugin:translator/request` and `plugin:translator/result` for every provider. Requests retain exact source, language tags, selected provider and recipe identity; a successful result references its request sequence. Optional request metadata holds provider-specific details without changing these record types. The translator checkpoints requests before external dispatch and completed results before returning them. Read-only cache lookup precedes provider work and needs no live Session; failures and incomplete attempts do not supply reusable text. New records use the active Session's existing writer. The translator opens no write handle and does not activate a Session. Translation records preserve the original events and model input. Anonymous calls without a Session stay stateless; paid routes require a Session. Experimental record retention across future format migrations is best-effort.

Paid cache misses require an active built-in Account or Official owner, configured credentials and exact `deepseek-flash` catalog membership; names and version labels are irrelevant, and pi-ai is excluded. Each miss prepares a separate text-only query with thinking off. Its exact config, system and unique user fragment occupy optional `metadata.modelRequest` in the same request record. Saved results are read before this admission, so missing credentials do not invalidate existing translations. Native request extensions receive no main Session identity and cannot upload its full log.

## Reasoning display

The [optional bundle](../../packages/experimental/cot-translation-bundle/README.md) composes the translator with the [GUI consumer](../../packages/experimental/client-ui-cot-translation/README.md). Its `cotTranslation` Remote serves authenticated browser calls. When a Session is inactive and has no saved result, the Host joins normal Session controller activation and retries once. Activation retains normal preset hooks, resume markers, and interrupted-turn repair; cancellation stops the caller's wait and prevents a later translation call without cancelling shared activation. Bundle settings select a translation service and target language; `auto` follows the active interface language.

`CotTranslationPreferences` contains the accepted provider and target language. `CotTranslationSnapshot` pairs these preferences with the translator's current `maxTextChars` and eligible provider IDs. The browser reads this Host snapshot before registering translation controls, including when local settings storage is unavailable. Accepted settings updates and reconnects refresh both values; a changed request limit cancels and splits the expanded text again.

The GUI registers in the session-scoped `conversation.chat.reasoning.body` single Slot, replacing Chat's default entry. Both entries reuse the official `conversation.chat.reasoning.content` Factory; the translation wrapper selects display text, owns its toolbar and view state, and supplies its localized labels without duplicating Markdown rendering. While enabled, the GUI translates completed paragraphs and request-sized prefixes of long streaming paragraphs only after expansion, and restores completed results from the current Session. Its local cache only optimizes that disclosure. The unfinished tail remains original. Original remains accessible. Closing the disclosure, switching provider or language, and unloading cancel outstanding calls and exclude late results. Provider failure preserves the original and requires an explicit retry; translated text never replaces original Session events or model input.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcottranslation--cottranslationcontroller"></a>

### `ctx.cotTranslation` — `CotTranslationController`

Optional reasoning translation delegates Session-bound storage to the translator.

```ts cordis-catalog
/**
 * Read accepted translation preferences and the current request limit without sending text.
 * @param signal - browser query cancellation or Remote contribution withdrawal.
 * @returns authoritative preferences, eligible routes, and maximum UTF-16 text length per request.
 */
@Remote async limits(signal: AbortSignal): Promise<CotTranslationSnapshot>

/**
 * Translate one displayed fragment through the reader's selected provider.
 * @param request - original text and Session identity supplied by the Client; provider and explicit
 * target language match accepted preferences, while auto uses the browser locale.
 * @param signal - browser cancellation or Remote contribution withdrawal.
 * @returns translated text; an uncached inactive Session joins ordinary GUI activation before retry.
 * Failures omit the source and provider response. Cancellation stops this caller's wait, not shared activation.
 */
@Remote async translate(request: TranslationRequest, signal: AbortSignal): Promise<string>
```

Source: [`packages/experimental/client-ui-cot-translation/src/index.ts`](../../packages/experimental/client-ui-cot-translation/src/index.ts)

<a id="ctxtranslator--translator"></a>

### `ctx.translator` — `Translator`

One Host service with explicit routing, cancellation and quiescent unload.

```ts cordis-catalog
/**
 * Inspect eligible native routes without inference; saved results remain readable for unavailable routes.
 * @param signal - optional caller cancellation, combined with service disposal.
 * @returns anonymous choices followed by eligible explicitly selected paid routes.
 */
async availableProviders(signal?: AbortSignal): Promise<readonly TranslationProvider[]>

/**
 * Resolve provider and source-language defaults without sending text.
 * @param request - consumer text, destination and optional routing choices.
 * @returns a complete specification; exceeding `maxTextChars` throws `TRANSLATION_TEXT_LIMIT`.
 */
resolve(request: TranslationRequest): TranslationSpec

/**
 * Translate one resolved specification; the selected provider receives its text.
 * @param spec - complete routing and language choices from `resolve()`.
 * @param signal - optional caller cancellation, combined with service disposal.
 * @returns translated plain text, durably retained before return when a Session is supplied.
 * An uncached supplied Session must be active; otherwise rejects with `TRANSLATION_SESSION_INACTIVE` before dispatch.
 * Rejects provider/storage/limit failures and preserves cancellation reasons.
 */
async translate(spec: TranslationSpec, signal?: AbortSignal): Promise<string>
```

Source: [`packages/experimental/translator/src/index.ts`](../../packages/experimental/translator/src/index.ts)
<!-- END GENERATED cordis-surface -->
