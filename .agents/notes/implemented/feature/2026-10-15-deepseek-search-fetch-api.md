# Agent Note: Direct DeepSeek Search and Fetch APIs

Status: implemented

English | [中文](2026-10-15-deepseek-search-fetch-api.zh.md)

## Problem

DeepSeek web retrieval through Messages requires an auxiliary model request for each query. Harness extracts sources and citation excerpts but discards the generated answer. The dedicated Search and Fetch APIs provide structured sources and Markdown directly, so retrieval can run without Harness starting that auxiliary generation. Adopting these APIs requires explicit selection of both operations, independent deployment addresses, and a mapping of Fetch results onto the existing fetch result.

## Decision

The [DeepSeek Search and Fetch guide](https://api-docs.deepseek.com/zh-cn/guides/search), checked on 2026-10-16, defines the upstream API. The [web-deepseek-api plugin](../../../../packages/web/web-deepseek-api/README.md) implements it behind the existing `web_search` and `web_fetch` tools, and [web-search-deepseek](../../../../packages/web/web-search-deepseek/README.md) keeps Messages search. The [web capability decision](../architecture/2026-06-24-web-capability-seam.md) continues to own provider selection, tool responsibilities, and the fetch result fields.

### Protocol selection and deployment

The APIs register as `deepseek-search-api` and `deepseek-fetch-api`; Messages search keeps `deepseek-official`. The setting **Use the new Web Search API** (**启用新版 Web 搜索 API**) on the Web search page writes `web.searchProvider` and `web.fetchProvider` together: on selects both APIs, and off restores Messages search with local HTTP fetch, the shipped selection. The switch defaults off and takes effect after saving, because the web service reads both selections for each operation. Messages remains the default until the Search API launch is announced, so existing users keep working search without configuration. Each operation resolves one settings snapshot, including its endpoint and credentials. Both APIs read one credential and one API base, because the guide serves them from one base and the switch selects them together.

The two protocols retain independent API bases. Messages keeps `https://api.deepseek.com/anthropic/v1` and appends `/messages`. Direct retrieval uses `web-deepseek-api.baseURL`, which defaults to the guide's public base `https://api.deepseek.com/v1/tools`, and appends `/search` or `/fetch`; the verified development base is `http://api-dev.deepseek.com:8031/api/v1/tools`. These prefixes are different and are never inferred from the hostname, so another deployment enters its complete base. The switch is already the explicit opt-in, so the documented public deployment serves as its default. A blank or unparseable base leaves both providers unavailable.

The guide specifies API-key Bearer authentication, and requests send only the documented authorization and JSON content type. A Session on the DeepSeek account route sends its account token instead, as Messages search does; the public Search and Fetch routes accepted it on 2026-10-16, so account-only users can enable direct retrieval. An Anthropic-compatible gateway checked the same day served Messages web search and had no `/v1/tools` routes; such deployments keep Messages search.

### Search results and model input

Direct Search sends `query`, `count`, `need_content: false`, and `ori_question`. `count` is the configured value from 1 to 50, defaulting to the service's 10, unless the request's result bound is smaller; the tool always sends its limit, 8 by default. `ori_question` is the text of the initiating Session's latest human prompt with whitespace collapsed and cut to the API's 128-character limit. The API rejects blank or longer values, so a search without such a prompt omits the field, and `sendOriginalQuestion: false` disables it. In 2026-10-16 probes, different values left result order, scores, and summaries unchanged. Queries pass through unchanged, including the documented site, language, date, exclusion, and exact-phrase operators. The service enforces the 1–128 Unicode-character query constraint. Empty `results` is successful.

The provider preserves service order and maps URL, title, `snippet`, `summary`, and nullable `date` into shared sources. Following the guide, the tool gives the model each source's `summary` and keeps the short `snippet` for the search card and its replay metadata. The guide's typical summary length is not a maximum: returned summaries measured 1,000–2,300 characters on 2026-10-16. `dsh-tool-web` therefore collapses summary whitespace and caps each summary at `searchSummaryMaxChars`, 800 characters by default, the upper end of the guide's typical range; one call's summaries stay within the source cap times that cap. The summary rides in the tool output value and rendered text, which the Session already records. The provider does not consume full `content`, `site_name`, `site_icon`, `rerank_score`, or `authority`, and it does not send `localization`. Those omissions are integration limits, not absent API capabilities.

Direct retrieval emits no auxiliary model-request event because Harness makes no such request. The normal tool-call and tool-result events retain the query and model-visible result. This says nothing about the search service's internal use of models. Returned text remains external, untrusted data.

### Fetch metadata and ownership

Fetch sends a URL and returns Markdown without an extra Harness summarization request. The API supplies neither a final redirected URL nor a target HTTP status, and the shared result has no title field. The provider keeps the requested URL, returns the Markdown body, and reports HTTP 200 for a successful response: the Fetch API answers 404 when the URL is unavailable, blocked by site policy, or returns an error, or when no Markdown can be extracted. On 2026-10-16 an unresolvable host returned HTTP 500 instead, so every non-success status is a retrieval failure rather than a specific target diagnosis. The shared fetch result and its consumers stay unchanged.

The HTTP provider retains its own URL validation and resource limits. Selecting DeepSeek delegates page retrieval and target access policy to that service; Harness rejects redirects of the API request and retains cancellation and bounded tool output. The reported HTTP 200 therefore means the service retrieved the page, not that Harness observed the target response. The guide's Fetch 403 means crawler-policy rejection, while 404 means no usable page content.

### Default migration

Changing the default to the Search API is a separate change after the launch is announced. API keys and account tokens both reach the public routes; deployments behind a gateway without `/v1/tools` routes need an explicit `web.searchProvider: deepseek-official` before the default changes, and a stored Messages selection keeps Messages.

### Supplementary Messages fix

The retained Messages path explicitly sends `thinking: { type: 'disabled' }` and records that same body before dispatch. This avoids reasoning work in an auxiliary request whose generated answer is discarded; it does not implement or control the new retrieval API. `tool_choice` remains omitted. The [persistence acknowledgement](../../../../docs/persistence-changes/2026-10-13-deepseek-search-thinking.md) owns compatibility for the optional logged field.

## Alternatives considered

**Keep Messages as the only search implementation.** It preserves auxiliary generation and response extraction even when callers need only sources. Direct Search removes that Harness model request while retaining Messages as an explicit mode.

**Make the Search API the default now.** The launch is not announced, and some gateways expose only Messages; their users would lose working search.

**Reuse the Messages address or infer a route prefix.** The protocols and deployed prefixes differ. Separate bases preserve existing configurations and avoid sending a valid request to the wrong route.

**Require an explicit Search API base.** Enabling the switch is already an explicit choice, and an empty default would make every user copy the documented public address. Other deployments still override it.

**Keep the APIs inside the Messages provider behind a provider-local switch.** A switch inside `web-search-deepseek` cannot change fetch routing, so turning it on left `web_fetch` on HTTP unless the user also edited `web.fetchProvider`; it also tied the APIs' lifecycle to Messages search, which the default migration may retire. Separate registrations let the web service's existing selection express the switch, and each package can change or retire alone.

**Share one transport between Messages search and the new APIs.** Both resolve credentials through the same seams, `ctx.credentials` and `ctx.deepseekAccount`, so a shared module would save only the dispatch and failure-mapping code. It would make the Messages package depend on the new API package and tie their releases, while the default migration may retire Messages search. Each package keeps its own transport until then.

**Split Search and Fetch into separate packages.** The guide serves both APIs from one base with one credential, and the switch selects them together; separate packages would duplicate the settings a user edits once. Each operation lives in its own module, so either API can change without the other.

**List every registered provider in a settings dropdown.** A generic provider form derives editors from Config schemas and needs host-side display metadata on the provider interfaces. The page needs only the DeepSeek choice, and other providers keep their own settings pages.

**Let the model supply `ori_question` as a tool argument.** The API defines the field as the user's original question, which the latest human prompt already records. A tool argument would change the model-facing schema shared by every search provider and invite paraphrase.

**Keep HTTP fetch when the switch turns on.** The switch adopts the new DeepSeek retrieval APIs, and leaving fetch on HTTP made Fetch API adoption depend on a hand-edited `web.fetchProvider`. HTTP fetch, with its own access policy, remains the selection whenever the switch is off, and configuration can still select either fetch provider alone.

**Add an extraction tool or widen the fetch result.** The API retrieves one concrete web page as Markdown, which fits the existing fetch operation. Its success already implies a retrieved page, and the Markdown body carries the page heading, so widening the result would change every fetch consumer for little model-visible gain.

## Consequences

Retrieval no longer requires auxiliary model tokens in direct mode, but its results still consume the main model's context. One Messages web search through a gateway on 2026-10-16 consumed 8,154 input and 828 output tokens for a single server-side search. The guide prices Search and Fetch independently at CNY 5 per 1,000 successful requests with results; result count does not change a request's price. Multiple queries remain multiple requests. The stated Claude Code and Codex promotion does not establish a Harness exemption. Search API mode also sends up to 128 characters of the user's prompt to the search service with each query unless `sendOriginalQuestion` is off.

Search and Fetch each have an account-wide 5 QPS limit, independent of model concurrency and shared across that account's API keys. Fetch also has a target-domain limit. The current tool can issue four queries concurrently and fails the batch if one query fails. The provider has no shared rate scheduler, automatic retries, or fallback; other Sessions or processes can exhaust the same account allowance.

## Verification and remaining API adoption

Provider tests cover request mapping, empty results, malformed responses, independent and default bases, account-token authentication, cancellation, and blank configuration. Settings tests and the [plugin configuration browser scenario](../../../../apps/web/tests/plugin-config.e2e.ts) cover staged saves, the default base, and switching both selections. The [web search replay](../../../../apps/web/tests/web-search-round.e2e.ts) and [Fetch Session replay](../../../../snapshots/session/deepseek-fetch/snapshot.yml) pin model-visible results. On 2026-10-16 the [real provider tests](../../../../packages/web/web-deepseek-api/tests/web-deepseek-api.e2e.ts) passed Search and Fetch against the public base, and a headless round on the shipped profile returned eight sources and fetched Markdown without an auxiliary request event. The account-token, gateway, and status observations above come from manual probes the same day.

The following capabilities remain outside the implemented integration:

- Expose search syntax in provider-appropriate tool guidance and define a bounded localization input before forwarding it. API `localization` is an IP address, not an inferred city or UI language.
- Retain quality metadata before defining selection policies. `rerank_score` and `authority` describe service assessments, not guarantees of truth; a hard cutoff can discard useful niche sources.
- Add cancellation-aware scheduling and bounded retry ownership. The guide recommends waiting before retrying 408, 429, and 5xx; 402 requires funding first, and other 4xx require a changed request. Local pacing cannot enforce an account-wide quota across unrelated processes.
