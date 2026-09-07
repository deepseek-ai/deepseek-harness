# Agent Note: Provider-routed LLM adapters and a generic pi-ai backend

Status: implemented

English | [中文](2026-07-14-provider-routed-llm-adapters.zh.md)

## Problem

`dsh-llm` registered adapters by exact model name. A plugin supplied a model list at Cordis startup, `LlmRuntime` stored one adapter per listed string, and `GenerateOptions.model` selected the adapter and the provider model at once. This worked while both shipping adapters targeted the same two DeepSeek models, but it conflated two independent decisions: which upstream provider owns a request, and which model that provider should run.

The conflation prevents a provider gateway from serving an open-ended model catalog. OpenRouter, for example, is one provider with many model ids, while a private OpenAI-compatible endpoint may add models without changing the Harness plugin tree. Every newly selected model currently needs to have been registered during plugin startup. The same model id can also exist at multiple providers, so model-only registration cannot state which provider the caller intended.

`dsh-llm-pi-ai` exposed none of pi-ai's provider abstraction. It constructed an inline DeepSeek `openai-completions` model, applied DeepSeek-specific payload patches, and stamped every replayed assistant message as DeepSeek. pi-ai itself has a provider/model catalog, selects APIs such as `openai-responses`, `anthropic-messages`, and `google-generative-ai`, and preserves provider-specific response ids and reasoning/tool signatures for later turns. The Harness conversion dropped the provider/model route and provider response fields, so simply replacing the inline model with a catalog lookup would have made same-model replay and cross-provider handoff incomplete.

The adapter configuration also assumes one DeepSeek API key and endpoint. A generic backend needs independent credentials and endpoint overrides per provider while leaving AWS, Google ADC, OAuth, and other ambient authentication mechanisms to pi-ai.

## Decision

### Provider is the adapter registration key

`GenerateOptions` and `LlmCallConfig` carry `provider: string` beside `model: string`; `AgentOptions` carries the corresponding optional creation field. A loop request is valid only after both values are non-empty, and both values are part of the logged request header. `agent/request` may return a replacement pair on any step, so a session can switch providers and models without changing the Cordis plugin lifecycle.

`LlmRuntime` registers and resolves adapters by provider. `registerAdapter(providers, adapter)` checks the entire provider list before mutating the registry, rejects a duplicate with `DUPLICATE_ADAPTER`, and disposes the whole registration as one effect. Model ids are not registration keys; the selected adapter still validates or forwards them. The later [LLM catalog and ACP selection Agent Note](../../archived/architecture/2026-07-15-llm-model-catalog-and-acp-selection.md) added advisory `listProviders()` / `listModels()` discovery without turning model membership into request validation.

A provider has exactly one adapter owner in a Cordis context. `dsh-llm-deepseek` registers `deepseek`; `dsh-llm-pi-ai` may also register `deepseek`, but loading both owners is a configuration error rather than an ordering rule or fallback. A deployment that wants the hand-rolled DeepSeek implementation excludes `deepseek` from the pi-ai profiles. A deployment that wants pi-ai's DeepSeek implementation does not mount `dsh-llm-deepseek`.

`dsh-llm-deepseek` removes its model registration list and accepts any model string routed through provider `deepseek`. Its request serialization, `/chat/completions` endpoint, thinking options, SSE parsing, and error behavior remain unchanged; `options.model` is still sent verbatim.

### Explicit pi-ai provider profiles

`dsh-llm-pi-ai` takes one non-empty list of provider profiles. Provider names must be unique within the list and present in pi-ai's `getProviders()` result. Each profile contains the provider name plus optional `apiKey`, `baseURL`, headers, reasoning level and budgets, cache retention, transport, SDK timeouts, a Harness stream-idle timeout, and a provider-owned `retryPolicy`. The adapter forces pi-ai's `maxRetries` to zero so one `stream()` call makes one visible provider attempt, while `dsh-llm-retry` executes the resolved policy at the agent failed-step extension point. Credentials are never global: an explicit key applies only to its profile, while an absent key lets pi-ai resolve its standard environment variable, OAuth token, AWS credential chain, Google ADC, or other provider-native ambient authentication. An explicitly empty key is invalid configuration rather than an environment fallback.

The plugin registers all configured provider names against one `PiAiAdapter` in one all-or-nothing call. A request uses its provider to select the matching profile and finds its model in `getModels(provider)` to obtain the catalog descriptor. An unknown provider fails at plugin load; an unknown model fails before network I/O with `UNKNOWN_MODEL`. The catalog object is never mutated. When a profile supplies `baseURL`, the adapter clones the selected descriptor and overrides only `baseUrl`, so a private endpoint can retain pi-ai's API, capabilities, compatibility flags, context limits, and reasoning map. The private endpoint must implement the selected provider's protocol, and the model id must still exist in the installed pi-ai catalog.

The adapter calls pi-ai's `streamSimple()` so each catalog model chooses its registered API implementation, including OpenAI Responses instead of Chat Completions where the descriptor says `openai-responses`. Harness temperature, maximum tokens, signal, session id, and the profile's common stream options flow through directly. Profile headers merge with the mandatory Harness attribution headers, with Harness attribution winning its reserved names. The adapter no longer maintains DeepSeek-specific payload rewrites or a provider-protocol matrix.

pi-ai's common stream options do not expose stop sequences. `dsh-llm-pi-ai` rejects a defined Harness `stop` option with `UNSUPPORTED_OPTION` rather than silently ignoring it or growing a second provider-specific payload implementation. `dsh-llm-deepseek` continues to support `stop` through its native request serializer.

### Recorded assistant route and replay state

Assistant messages carry the request's `provider` and `model`, plus an optional JSON-serializable adapter replay state. A successful `assistant/message` session event records those fields and `deriveMessages()` returns them with the assistant message. User, system, context, and tool-result messages carry no assistant route fields. The provider/model fields are authoritative loop data; an adapter owns only its opaque replay-state payload.

A terminal successful `finish` chunk may carry replay state as a `ReplayEnvelope`: opaque response-level metadata plus optional per-block entries aligned with the emitted block sequence. `BlockAssembler` makes one keep/drop decision for content and metadata — when max-token assembly drops a tool call, the envelope loses the entry at the same position — so the state the loop attaches to the assembled assistant message's model source always describes the stored blocks, per the [max-token replay-state alignment decision](../../archived/bug-fix/2026-08-15-max-token-replay-state-alignment.md). The loop exposes no response-rewrite hook. Error and aborted responses do not produce a normal assistant message and therefore do not enter future model history.

The pi-ai replay state fills that envelope with a versioned, minimal projection of its successful `AssistantMessage`: a response half (source API/provider/model, response id/model, optional provider-native effort, stop reason) and per-block text, thinking, and tool-call signatures. The [pi-ai upgrade compatibility decision](../bug-fix/2026-09-05-pi-ai-upgrade-compatibility.md#decision) defines requested-versus-native Anthropic model identity and effort preservation. It does not duplicate text or tool arguments already carried by Harness content blocks, and it omits diagnostics, timestamps, usage, and errors. On a later request, `LlmRuntime` gives replay state to the target adapter only when the historical provider and target provider are currently owned by the same adapter instance. That adapter combines the logged Harness content with replay state when it can restore the historical response, and owns any required cross-model or cross-provider conversion. Durable content stays authoritative: an adapter receiving replay state it cannot use — an unknown kind or version, malformed metadata, or a block shape that no longer matches the content — degrades that message to provider-neutral conversion with a diagnostic; a different adapter receives only provider-neutral content plus provider/model fields.

This state is model-visible replay input and therefore follows the existing [reconstructable-request rule](2026-07-05-reconstructable-requests.md): it is present in both the terminal `finish` chunk and the assembled `assistant/message` model source that drives derivation. Resume and fork preserve it verbatim. Compaction that shadows the assistant message also removes its replay state from the active surface; the summary is ordinary provider-neutral content.

### Propagate the target through every request producer

Every model-selection path carries provider and model together: declarative agents, ACP and stdio app config, the JSON-RPC initialize request, subagent overrides and inheritance, workflow child overrides, and direct compaction summarization. Subagents inherit both fields from their parent before applying request overrides. The system-prompt variable set gains `provider` beside `model`.

Compaction configuration gains `summarizationProvider` beside `summarizationModel`. Both are empty to inherit, or both are non-empty to select an explicit target; a half-configured pair fails load. Inheritance uses the last logged request target when one exists and falls back to the agent's creation options. `compaction/summary` records both fields with the existing model-call envelope.

The JSON-RPC runtime receives provider and model explicitly. Its convenience fallback mounts `dsh-llm-deepseek` only for provider `deepseek` when that provider has no registered owner; other missing providers fail without guessing an adapter.

Current v1 seed/load validation rejects request headers and assistant messages that omit required provider/model fields. The frozen v0-to-v1 edge requires the same reconstructable routing identity before migration; it never guesses a missing provider or model, and malformed shapes refuse before publication.

## Alternatives considered

**Keep model names as registry keys and add wildcard adapters.** A wildcard introduces fallback ordering between exact registrations and catch-all plugins, makes duplicate ownership dependent on listener order, and still cannot distinguish the same model id at two providers without another convention.

**Encode provider and model into one string.** Values such as OpenRouter's `openai/gpt-*` already contain provider-like prefixes and slashes. A delimiter convention would leak routing syntax into every model selector and require escaping rules; two explicit fields are unambiguous and independently loggable.

**Add `backend + provider + model`.** A backend key would allow `dsh-llm-deepseek` and pi-ai's DeepSeek implementation to coexist and switch per request. The accepted deployment rule is instead one adapter owner per provider: implementations of the same upstream are alternatives selected by plugin composition. A third routing dimension would burden every request and configuration for a capability with no current consumer.

**Let `dsh-llm-pi-ai` automatically register every pi-ai provider.** This would claim ambient credentials and provider names the deployment never intended to expose, and would conflict with native adapters such as `dsh-llm-deepseek`. Explicit profiles make capability and credential scope reviewable.

**Mount one pi-ai plugin instance per provider.** Separate instances isolate config but repeat plugin declarations and cannot make profile registration atomic. One adapter already receives provider on every request, so a validated profile map is the smaller lifecycle API.

**Accept arbitrary inline pi-ai model descriptors.** This would support catalog-external private model ids, but it exposes pi-ai's model and compatibility schema as Harness configuration and makes the adapter responsible for validating protocol-specific combinations. The first version supports custom endpoints by overriding `baseURL` on catalog models; custom descriptors require a separate decision after a real catalog-external deployment is identified.

## Consequences

- Provider names are deployment-wide route ownership keys: two providers may use the same model string, but mounting two adapters for one provider fails at load instead of creating fallback order.
- Model selection no longer changes the Cordis plugin graph. Catalog-backed adapters can accept any installed catalog model selected after startup, while the native DeepSeek adapter forwards arbitrary DeepSeek model ids.
- A custom `baseURL` preserves the selected catalog model's protocol and capabilities; it does not make catalog-external model ids valid. Private endpoints must implement that catalog entry's protocol.
- pi-ai credentials, transport knobs, SDK timeouts, and the five-minute-default `streamIdleTimeoutMs` watchdog are scoped per provider profile. Hidden provider retries are disabled; bounded retries belong to the separately composed agent recovery policy.
- `dsh-llm-pi-ai` rejects stop sequences because pi-ai's common stream API cannot express them; the native DeepSeek adapter retains its stop support.
- Replay state is portable only within the adapter instance that owns both the historical and target providers. Cross-provider and cross-model restoration is an adapter responsibility, and another adapter receives provider-neutral history without the opaque state.
- Current v1 Session JSONL requires provider/model on request headers and assistant messages. The v0 edge migrates only frozen shapes that already carry reconstructable request identity.

## Testing

- Unit coverage exercises registry conflicts, request reconstruction, session validation, profile resolution, single-attempt option forwarding, native API selection including OpenAI Responses, conversion, replay validation, error mapping, caller cancellation, idle-timeout transport termination, content rewrites, and same-instance versus different-instance replay dispatch.
- Keyless loop/session tests and ACP snapshots exercise durable provider/model metadata, resume and fork propagation, workflow/subagent overrides, and unchanged user-visible transcripts; the key-gated DeepSeek e2e retains real provider streaming and tool follow-up coverage.
- Public JSDoc, package READMEs, architecture and subsystem docs, generated catalogs, examples, session fixtures, and Python SDK pairs use provider/model targets consistently and are checked by the repository documentation and type-equivalence gates.

## Risks

This was a repo-wide API break when introduced: model-only request construction, adapter registration, app protocols, fixtures, and persisted v0 event shapes changed together, with no compatibility aliases. Released historical recovery now belongs to the adjacent Session-format edge. The provider exclusivity rule deliberately prevents two implementations of the same upstream from coexisting in one context. A pi-ai dependency update can change the accepted provider/model catalog, so the lockfile and adapter e2e matrix define the tested set. Custom `baseURL` endpoints inherit the chosen catalog model's protocol assumptions and cannot repair an incompatible proxy. Catalog-external model descriptors and multimodal content remain unsupported. pi-ai replay state may contain opaque encrypted reasoning signatures; it is persisted because the provider requires it for continuity, but it is never rendered or logged outside the existing session record.
