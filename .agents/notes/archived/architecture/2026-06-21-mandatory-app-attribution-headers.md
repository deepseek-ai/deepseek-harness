# Agent Note: Mandatory `User-Agent` attribution for provider requests

Status: implemented
Archived: 2026-09-30

English | [中文](2026-06-21-mandatory-app-attribution-headers.zh.md)

## Problem

LLM provider requests should identify the product making them. That is useful for provider-side support, abuse investigation, compatibility debugging, and traffic analytics. Before this Agent Note the harness only partially did this: the hand-rolled DeepSeek adapter sent a hand-copied `User-Agent` constant (`packages/llm/llm-deepseek/src/adapter.ts`), while the pi-ai-backed twin sent no harness-owned headers at all (`packages/llm/llm-pi-ai/src/adapter.ts`). New adapters could therefore omit attribution silently, and a library-backed adapter could drift from the hand-rolled adapter even though [the twin-adapter Agent Note](2026-06-13-twin-llm-adapters.md) exists to keep the provider contract honest across both implementations.

The immediate prompt came from OpenRouter's [App Attribution](https://openrouter.ai/docs/app-attribution) docs. OpenRouter creates app pages and rankings from `HTTP-Referer` plus display/category headers. That is valuable, but it is not the HTTP standard for application identity. The risk is adopting OpenRouter's exact header set as if it were universal, then leaking provider-specific headers to direct DeepSeek requests, future OpenAI/Anthropic/Vertex adapters, test servers, or proxies that log unknown fields indefinitely.

## Investigation

- **OpenRouter's mechanism is provider-specific.** Their current docs say app attribution is tracked through `HTTP-Referer` (required), `X-OpenRouter-Title`, and `X-OpenRouter-Categories`; `X-Title` is only accepted for backward compatibility. Their API reference calls the headers optional and says they make the app discoverable on OpenRouter. This is a concrete OpenRouter contract, not an IETF or OpenAI-compatible API standard.
- **In agent tooling, `HTTP-Referer` is an OpenRouter-aware convention, not a general agent convention.** It is common enough that OpenRouter SDKs and OpenRouter examples expose it directly, and frameworks that target OpenRouter usually need a way to pass it through. But agent protocols such as ACP negotiate names, versions, and capabilities in their own initialize messages, while model-provider requests still need HTTP-level identity. "Accepted in the agent world" therefore means "recognized by OpenRouter integrations," not "portable across agent runtimes or providers."
- **Coding agents identify the product and version in `User-Agent`.** Public implementations vary in environment detail and provider-specific side headers, but product identity is the common contract; there is no universal exact format.
- **The standards-track general client identity header is `User-Agent`.** RFC 9110 section 10.1.5 defines `User-Agent` as the user-agent software identity, says it is used for interoperability reports and analytics, and says a user agent SHOULD send it on each request unless configured not to. This is the only standard header that directly matches "what product is making this HTTP request."
- **`Referer` is standard, but OpenRouter's `HTTP-Referer` is not the standard field.** RFC 9110 section 10.1.3 defines `Referer` as the URI from which the target URI was obtained and spends significant text on privacy restrictions. OpenRouter instead asks for `HTTP-Referer`, using it as an app URL identifier. That name and meaning are OpenRouter-specific even though it resembles the CGI environment variable form of the standard `Referer` header.
- **`From` is standard but not suitable as a mandatory default.** RFC 9110 section 10.1.2 defines `From` as an email address for the human responsible for a user agent. Robotic agents SHOULD send it so servers can contact an operator, but non-robotic agents should not send it without explicit user configuration because of privacy and security policy concerns. The harness can support an operator contact later, but must not invent one or require it globally.
- **Request-body `user` or `metadata` fields are not app attribution.** Some model APIs expose a stable end-user identifier, request metadata, labels, or project/account headers. Those are useful for abuse monitoring, internal billing, dashboards, or trace correlation, but they either identify the end user rather than the product, are provider-specific body schema, or are not guaranteed to be forwarded through OpenAI-compatible gateways. They are not a substitute for a static application identity header.
- **SDK telemetry headers identify the SDK, not the app.** Official and third-party SDKs often send library/version headers. Those help the SDK maintainer debug their client, but they do not identify the harness as the application unless the application explicitly supplies a product attribution layer.
- **pi-ai has a first-class header hook.** `@earendil-works/pi-ai`'s `StreamOptions.headers` merges caller headers last over provider defaults, so a library-backed adapter can satisfy the same wire contract as the hand-rolled one without wrapping or upstream work. The mock-server suites assert arrival on the wire for both adapters.

## Decision

Provider-neutral app attribution is mandatory at the LLM adapter boundary, using the standard `User-Agent` header only. The rule: every product LLM adapter sends a static, non-secret application identity on every provider HTTP request, and every adapter has tests proving that `User-Agent` reaches the wire (a mock server asserting received headers; for a library-backed adapter, the library's header hook feeding the same mock-server assertion). This rule governs app attribution, not provider-specific request identity: [the DeepSeek request-identity decision](../feature/2026-08-11-deepseek-request-user-id-header.md) separately owns its user and session headers.

OpenRouter app attribution is deliberately not implemented. `HTTP-Referer`, `X-OpenRouter-Title`, `X-Title`, and `X-OpenRouter-Categories` are OpenRouter-specific product-surface headers, not provider-neutral model-request attribution. They can be proposed later by an OpenRouter adapter or explicit OpenRouter mode, with its own privacy/product decision, tests, and docs. Until then, even requests pointed at OpenRouter send only the shared `User-Agent` attribution from this decision.

The provider-neutral identity is owned by `dsh-llm` (`packages/llm/llm/src/attribution.ts`), not by individual adapters. `AppIdentity` contains only public product facts needed to build `User-Agent`, and the default `APP_IDENTITY` values:

- product token for `User-Agent`: `deepseek-harness` (continuity with the pre-Agent Note wire value and the repo/org identity)
- version: read from the owning package's manifest via `createRequire`, never a hand-copied constant
- app URL: `https://github.com/deepseek-ai/deepseek-harness` - the repository home

The default is mandatory and non-empty. White-label deployments pass their own `AppIdentity` to `attributionHeaders(identity)` - the override hook is the function parameter, with no deployment config plumbing until a consumer needs it - and omission falls back to the harness default rather than suppressing attribution. There is no per-request API for the model, user prompt, session id, cwd, user email, API key owner, or local machine identity to influence these fields.

Wire mapping (`attributionHeaders`; header names lowercase in code - HTTP field names are case-insensitive on the wire):

| Target | Mapping |
|---|---|
| All HTTP-based adapters | `User-Agent: {product}/{version} (+{url})` - the parenthesized `+url` comment stays within RFC 9110's conservative product/comment syntax. |
| Direct DeepSeek endpoint | `User-Agent` for app attribution; `x-deepseek-harness-user-id` and conditional `x-deepseek-harness-session-id` are separate request identity under the DeepSeek-specific decision. Do not send OpenRouter-only headers unless DeepSeek documents an equivalent contract. |
| OpenRouter endpoints | `User-Agent` only. This decision excludes `HTTP-Referer`, `X-OpenRouter-Title`, `X-Title`, and `X-OpenRouter-Categories`. |
| Future providers | `User-Agent` only unless a later provider-specific Agent Note accepts additional headers. Do not reuse `HTTP-Referer` by analogy. |

Endpoint detection is not part of this Agent Note because no endpoint-specific mapping is accepted here. If OpenRouter support lands later, detection must be explicit: either a dedicated OpenRouter provider package or an explicit `provider: 'openrouter'` / `attributionTarget: 'openrouter'` config, not arbitrary path fragments or model names.

## Verification

The landed contract:

- `dsh-llm` documents the mandatory `User-Agent` attribution contract for `LlmAdapter` authors (`LlmAdapter` JSDoc, package README, and the adapter-contract section of `docs/subsystems/llm-streaming.md`).
- A shared helper (`attributionHeaders` / `userAgent`) constructs the app identity and the standard `User-Agent` value from package metadata, so adapters do not hand-copy version constants.
- `dsh-llm-deepseek` sends the shared `User-Agent` on every request and its mock-server suite asserts the exact value.
- `dsh-llm-pi-ai` sends the same `User-Agent` through pi-ai's `StreamOptions.headers` hook and its mock-server suite asserts the exact value.
- No adapter sends OpenRouter-specific attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`, `X-Title`, `X-OpenRouter-Categories`) as part of this decision.
- No app-attribution field carries secrets, local paths, session ids, prompt text, model output, user email, or per-user stable identifiers.
- The adapter READMEs state the `User-Agent` attribution policy and explicitly avoid documenting OpenRouter app attribution as implemented behavior.

## Alternatives considered

**OpenRouter app attribution now.** Rejected for this decision. Sending `HTTP-Referer` plus `X-OpenRouter-Title` would satisfy OpenRouter rankings, but those headers are a provider-specific product feature, not the provider-neutral model-request attribution this decision standardizes. Supporting them should be an explicit OpenRouter adapter/mode decision later, not hidden inside the first shared attribution helper.

**OpenRouter headers everywhere.** Rejected. It would treat a custom OpenRouter contract as a universal standard and send fields with misleading semantics to providers that did not ask for them. It also risks using `HTTP-Referer` as a generic app URL field even though standard HTTP already has `User-Agent` for product identity and `Referer` for a different browsing-context concept.

**Only provider account/project identity.** Rejected. Organization/project headers, API keys, cloud accounts, and billing projects identify who pays or owns the request, not which application is sending traffic. They also expose no public app title/category and do not help gateways like OpenRouter build app rankings.

**End-user `user`/`metadata` fields.** Rejected for this Agent Note. Those are valuable for abuse monitoring and customer support but describe the human or tenant behind a request. App attribution must be static product identity and safe to send on every request.

**Config-only opt-in attribution.** Rejected. A default-off setting is exactly how adapters keep drifting. The policy is mandatory default attribution with overrideable public values, not optional attribution.

**SDK-named token (`deepseek-harness-sdk`).** Considered for the `User-Agent` token because the supported runtime client stack uses the SDK name. `deepseek-harness` won because it names the DeepSeek Harness product, matches the org/repo identity and package scope, and keeps wire attribution stable without calling the complete product an SDK.

## Consequences

**Providers see that traffic comes from the harness.** That is the point, but it means deployments that previously blended into generic SDK traffic become identifiable. Mitigation: send only static public product data and let forks/white-label deployments pass their own `AppIdentity`.

**Header support differs by client library.** The hand-rolled adapter sets headers directly; the pi-ai-backed adapter depends on pi-ai continuing to honor `StreamOptions.headers` (merged last over provider defaults). The wire-level mock-server tests are the guard: if a pi-ai upgrade stops delivering the header, the suite goes red. This is useful pressure on the abstraction: a provider adapter that cannot set mandatory headers cannot fully implement the harness LLM contract.

**OpenRouter rankings do not benefit yet.** `User-Agent` is the correct baseline for provider-neutral HTTP identity, but it will not create OpenRouter app pages or rankings because OpenRouter requires `HTTP-Referer` for that product feature. That is deliberate: public app marketplace participation is a separate product decision, not a prerequisite for mandatory request attribution.
