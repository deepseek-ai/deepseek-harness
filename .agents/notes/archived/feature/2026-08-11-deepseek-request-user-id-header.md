# Agent Note: DeepSeek request user and session identity headers

Status: implemented
Archived: 2026-09-30

English | [中文](2026-08-11-deepseek-request-user-id-header.zh.md)

## Problem

Direct DeepSeek requests already carried `x-deepseek-harness-session-id` when the caller supplied `GenerateOptions.sessionId`, which lets provider-side support and diagnostics correlate turns within one conversation. They lacked a stable identity across sessions even though the harness already persists an anonymous user id for telemetry and feedback. A separate id would break correlation, while putting it in the provider-neutral attribution helper would send a stable per-user identifier through every HTTP adapter.

The user id is transport metadata, not model input. It must not enter the request body, prompt, token accounting, KV-cache identity, or session log. The destination is the adapter's resolved `baseURL`, which can be DeepSeek itself or a configured gateway, so the privacy boundary must be explicit.

## Decision

`dsh-llm-deepseek` sends `x-deepseek-harness-user-id` on every provider request sent after successful credential resolution. The value comes from `@deepseek-ai/dsh-anonymous-user-id` and therefore matches the OpenTelemetry Resource `user.id` and `/feedback` acknowledgement for the same `$DSH_HOME`. The adapter continues to send `x-deepseek-harness-session-id` only when `GenerateOptions.sessionId` is present; the agent loop supplies the current durable `Session.id` for ordinary agent, title-generation, and compaction requests.

The plugin resolves the user id lazily after credentials succeed and memoizes it for that plugin instance. A missing credential therefore does not create `.anonymous-user-id`, while the first authorized provider request can create it even when `DSH_TELEMETRY_DISABLED` is set. The direct adapter constructor accepts a `resolveUserId` dependency so wire behavior remains deterministic in unit tests.

Both headers are model-hidden HTTP metadata sent to the resolved `baseURL`. The identity values are absent from the JSON request body and do not become model-visible inputs or session events. A configured gateway receives them. Provider-specific body extensions are owned separately by the [DeepSeek LLM API extension decision](../architecture/2026-08-21-deepseek-llm-api-request-extensions.md). SessionTelemetryBackend sharing controls only telemetry export and does not disable provider request identity.

## Verification

- The mock provider asserts that an authorized request carries the same user id returned by `getOrCreateAnonymousUserId()` and omits the session header when no session id is supplied.
- The session-identity wire test asserts both headers and preserves the exact supplied session id.
- A direct-adapter test asserts that user-id resolution happens once per stream, while the keyless configuration test proves a credential failure does not create `.anonymous-user-id`.
- The real Loader composition test asserts that the assembled plugin uses the shared user-id package rather than a test-only value.
- No keyless snapshot changes because the headers are not model-visible or user-visible transcript content.

## Alternatives considered

| Rejected | Reason |
|---|---|
| Add the id to generic `attributionHeaders()` | That helper is provider-neutral and static; a per-user value there would reach unrelated providers and violate its app-identity privacy contract |
| Configure a fixed custom header in `cordis.yml` | Deployment configuration cannot derive the current session id and would expose a stable identity as mutable config instead of using its owning runtime contract |
| Mint a DeepSeek-specific user id | Provider requests could not correlate with telemetry and feedback for the same harness home |
| Disable the header with telemetry sharing | Provider request identity and telemetry export have different recipients and purposes; one switch would hide the actual privacy boundary |
| Put the id in OpenAI-compatible `user` or `metadata` request fields | Body fields can affect provider schema, logging, caching, tokenization, or model-visible reconstruction; HTTP metadata preserves the intended boundary |

## Consequences

- DeepSeek support can correlate requests across sessions by one anonymous harness-home id and within a conversation by the durable session id.
- The first authorized DeepSeek request may create `$DSH_HOME/.anonymous-user-id` independently of telemetry export.
- Custom DeepSeek gateways receive the stable user id and any available session id, so operators must treat the configured `baseURL` as an identity recipient.
- The identity headers do not alter the request body, prompt, token count, KV-cache identity, or session log; separately registered DeepSeek body extensions retain their own contracts.
