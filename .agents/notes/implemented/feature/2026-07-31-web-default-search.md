# Agent Note: Default Web search in shipped compositions

Status: implemented

English | [中文](2026-07-31-web-default-search.zh.md)

The [shared-base Web fetch default](../../archived/feature/2026-09-01-shared-base-web-fetch-default.md) supersedes this record's fetch opt-in decision. This record remains authoritative for the default search provider, credential resolution, endpoint, timeout, and the separation between provider availability and model-tool registration.

## Problem

The harness had a complete Web capability family—provider registry, DeepSeek/Exa/Perplexity search providers, local fetch, stable model tools, and structured result presentation—but the shipped `dsh web` composition mounted none of it. The model could not discover current information unless a deployment supplied a custom overlay. Merely mounting the existing DeepSeek provider would not complete the WebUI path: the Models page stores `DEEPSEEK_API_KEY` through `ctx.credentials`, while the search provider froze only the process environment at plugin load, so a key entered or rotated in the running UI would not reach search.

## Decision

`packages/bundle/base/cordis.patch.yml` explicitly mounts `dsh-web` with `searchProvider: deepseek-official` and `fetchProvider: http`, `dsh-web-search-deepseek`, `dsh-web-fetch-http`, and `dsh-tool-web` with `searchTimeoutMs: 60000`. The [shared-base Web fetch default](../../archived/feature/2026-09-01-shared-base-web-fetch-default.md) owns the current `fetch: true`; this record continues to own provider selection, search credentials, and timeout. Explicit provider ids keep selection independent of registration order and leave personal or `--patch` overlays able to replace or disable the rows. The one-minute shipped budget covers an auxiliary DeepSeek Messages request plus server-side retrieval while leaving `dsh-tool-web`'s provider-neutral 30-second default unchanged for custom compositions. The [Web capability seam decision](../architecture/2026-06-24-web-capability-seam.md) owns the public-fetch security policy.

DeepSeek search uses the same `DEEPSEEK_API_KEY` credential reference as the official conversation adapter. The provider resolves that reference inside every search through the optional `ctx.credentials` service; only a composition without the seam falls back to the launching process environment, and a non-empty literal `apiKey` remains the programmatic last resort. A stored or rotated Web Models key therefore reaches the next search without restarting or retaining the value on the provider. Because `WebSearchProvider.available()` is synchronous, it treats an installed resolver as locally usable and missing dynamic credentials fail the operation with the provider-specific `WEB_PROVIDER_CREDENTIAL_MISSING` code while the stable tool schema stays registered.

Search keeps its endpoint distinct from chat completions: `DEEPSEEK_SEARCH_BASE_URL` overrides the Anthropic-compatible base, while `DEEPSEEK_BASE_URL` continues to configure conversation requests. Each `web_search` performs an auxiliary DeepSeek Messages call with the native search server tool. Immediately before dispatch, the provider appends a log-only `web/deepseek-search-llm-request` event to the initiating Agent session with the resolved endpoint, API version, and exact secret-free JSON body. A failure after dispatch names that endpoint and tells the conversation model to guide the user to the Web search Endpoint field in Settings when the endpoint is unintended. The message names `DEEPSEEK_SEARCH_BASE_URL` and `web-search-deepseek.baseURL` when that settings page is unavailable; the model does not select or change the credential destination. Credential preflight remains provider-local and races caller cancellation; neither concern expands the generic Web or credentials seams.

The default mount does not create a Web-specific permission policy. `web_search` and enabled `web_fetch` calls execute outside the shell/filesystem sandbox and approval presets, following `dsh-tool-web`'s existing contract. The HTTP provider restricts fetches to validated public destinations, but it does not constrain public data egress. The shipped `workspace-write` default governs file mutations only; a restricted-network product stance requires a `tools/pre-execute` policy or capability-specific network confinement rather than implying that filesystem access mode governs Web calls.

## Alternatives considered

**Mount only `dsh-tool-web`.** Rejected because stable schemas without registered providers would make every default call fail; enablement and backend availability are deliberately separate, but a shipped default must supply its intended implementations.

**Read `$DSH_HOME/.env` from `cordis.yml` or hoist it into `process.env`.** Rejected because the credential provider owns that document, environment values are read-only overrides, and hoisting would make stored keys unrotatable while bypassing the audited secret boundary.

**Freeze `process.env.DEEPSEEK_API_KEY` at provider load.** Rejected because the Web Models page writes through `ctx.credentials`; the product's documented first-run path must make the next operation work without a restart.

**Keep Web tools in `web.cordis.yml`.** Rejected because it preserves an unexplained tool-roster difference between TUI and Web/headless. The rows are not surface-specific, so `base.cordis.yml` is their one home; the [tool-roster decision](2026-07-31-even-out-shipped-tool-rosters.md) records the shared composition.

**Raise `dsh-tool-web`'s provider-neutral timeout.** Rejected because custom providers and deployments own different latency expectations; the shipped DeepSeek composition owns this deployment budget.

**Enable fetch on every shared-base surface.** This record rejected the alternative because shared-base products could require different network policies. The [shared-base Web fetch default](../../archived/feature/2026-09-01-shared-base-web-fetch-default.md) supersedes that rejection after the shipped products converged on one full tool roster; its public-destination and no-approval constraints remain current.

## Consequences

Native model requests on headless, full SDK, ACP, and custom base-only profiles carry the `web_search` and `web_fetch` schemas and guidance; Web presets expose the same pair, including beneath `run_code` in PTC mode. Search adds a complete auxiliary model call and may use the native server tool multiple times; its exact secret-free request remains reconstructable from the initiating session log. Fetch enforces public addresses and requires no per-call approval. The Web snapshot lane boots the shipped tree, drives a replayed `web_search` call through the real DeepSeek provider against a local Messages fixture, asserts the durable auxiliary request and structured result, and pins the settled browser presentation. Shared snapshot headers pin the common fetch schema and prompt guidance. Composition smokes pin the tool roster; the built composition dump pins the one-minute shipped search budget; provider tests pin missing, stored, and rotated credential behavior plus literal and ambient compatibility.
