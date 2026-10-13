---
description: "DeepSeek account authentication, model listing, and model gating."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek-account

English | [中文](README.zh.md)

## Summary

Register authentication, the account model listing, and model gating for `deepseek-account`. This plugin shares the [Messages transport](../llm-deepseek/README.md) and owns credential resolution, the account catalog, and model admission.

Authentication resolution returns `x-dsh-auth-token` and a failure callback capturing the same token. HTTP 401 classification and rejection stay in this provider; a rejected older request cannot clear a replacement login.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Only `deepseekAccount.resolveToken(url)` supplies the token; the account service validates the destination. Signed-out or ineligible requests fail with `ACCOUNT_SIGN_IN_REQUIRED` and discovery returns an empty catalog. The route never falls back to an API key. Other credential lookup errors propagate.

The route's catalog comes from the account's `GET /models` listing at the origin of the Messages `baseURL` (`https://api.deepseek.com/models` for the official endpoint); the listing endpoint is not configurable. Listing requests carry the account token in `x-dsh-auth-token` and the harness `User-Agent`, and reject redirects.

The first access of a credential waits for the listing up to `modelsTimeoutMs`. Later accesses use the loaded listing and refresh it in the background once it is older than `modelsMaxAgeMs`. A failed or empty listing keeps the previous one; before any listing loads, the route serves the built-in catalog of the current version (`deepseek-flash` and `deepseek-v4-pro`). A listing HTTP 401 does not remove the stored login. Each loaded listing, the first failure of a failing streak with the catalog it falls back to, and each hidden listing entry are written to the console with the `[llm-deepseek-account]` tag; secrets are never logged. Each account token has its own listing, so the service can roll a model out to some accounts first.

A listed model is offered only when the current DeepSeek Harness version can serve it. A model that declares `client_requirements["deepseek-harness"].min_version` is offered when the current version is at least that version in semantic-version order, including prerelease tags such as `0.2.0-alpha.1` and `0.2.0-rc.1`. A prerelease orders below its release: `min_version: 0.2.1` refuses `0.2.1-alpha.2`, so a listing that admits prereleases declares the earliest one it admits, such as `0.2.1-alpha.0`. A model without that declaration is offered only when the built-in catalog knows its id; other listed models stay hidden. A request for a listed model the current version cannot serve fails before network I/O with `CLIENT_UPGRADE_REQUIRED`, which names the required and current versions, or with `MODEL_UNSUPPORTED`. Model ids the listing does not name pass through unchanged.

Offered models take the listing's name, `context_window`, input modalities, and Messages system prompt mode over the bundled entry for the same id, which keeps its tool-update mode, image budgets, and description. `max_output_tokens` bounds the request default: a request that names no cap sends the smaller of `maxTokens` and that capability. The listing's effort levels are not read; every model offers `off`, `low`, `high`, and `max`.

`modelOverrides` adjusts single models without replacing the catalog. Keys are model ids; values take the fields of a [Messages `models` entry](../llm-deepseek/README.md#minimal-configuration), and unset fields inherit. Overrides apply over the listing and the bundled catalog; they cannot add models or make a refused model available. Listed capabilities do not bound an override: an override `maxTokens` above the listed `max_output_tokens` is sent as written, and the service rejects requests beyond its limits. An override that names a model neither the listing nor the built-in catalog describes, or that the listed model rejects, becomes the provider diagnostic on the Models page, which has no editor for this route. An override for a refused model that the built-in catalog does not describe is checked only once the current version can serve that model. The route has no `models` field; a configuration that still sets it fails at load and names `modelOverrides`. Edit `$DSH_HOME/profiles/<profile>/cordis.patch.yml`; the next request uses the change.

```yaml
- id: llm-deepseek-account
  name: '@deepseek-ai/dsh-llm-deepseek-account'
  config:
    reasoningEffort: high
    modelOverrides:
      deepseek-flash:
        contextWindow: 524288
        maxTokens: 131072
```

| Field | Default | Meaning |
|---|---|---|
| `modelsTimeoutMs` | `5,000` | Deadline of one listing request and of a first-access wait |
| `modelsMaxAgeMs` | `600,000` | Listing age after which the next access refreshes it; a failed load retries after the same age |
| `modelOverrides` | `{}` | Field overrides by model id |

An account request HTTP 401 maps to `ACCOUNT_TOKEN_INVALID` independently of the response body. The account service removes the credential only if it still matches the request token. HTTP 403 and other failures do not clear the login. The account module owns task cancellation after sign-out; this plugin does not inspect Agents.

The settings namespace is the Cordis entry id, or the plugin name without an entry. Product profiles retain the official entry id `llm-deepseek` and use `llm-deepseek-account` for the account route.

<a id="understand-the-implementation"></a>
## Understand the implementation

Registrations and listeners dispose with the plugin, and disposal aborts an in-flight listing request. Shared Host wiring supplies attachments, request extensions, anonymous identity, and atomic retry-policy updates; this plugin registers only its own route and uses the transport's `connect` and `admit` hooks for the catalog and the gate. The listing cache lives in memory and is keyed by endpoint and a SHA-256 of the token.

A failed request the shared transport classifies as `QUOTA` is rewritten to `ACCOUNT_QUOTA` before it leaves this provider, covering an HTTP 402 response and an in-band SSE error alike. The shared transport and the `deepseek-official` route keep `QUOTA`, so the account route's top-up action never appears for an API-key or third-party failure.

<a id="further-exploration"></a>
## Further Exploration

[LLM streaming](../../../docs/subsystems/llm-streaming.md) · [Messages](../llm-deepseek/README.md) · [Account catalog decision](../../../.agents/notes/implemented/architecture/2026-09-24-deepseek-account-remote-model-catalog.md)

<a id="model-experience"></a>
## Model Experience

### Authenticated model requests

#### What the model sees

Requests on `deepseek-account` add no model-visible text from this plugin; the shared Messages transport serializes requests.

#### Token effect

Authentication and the listing add no input tokens. The resolved catalog sets each model's context window and default output cap, which each request's logged context and header record.

#### KV Cache effect

Credentials and catalog availability do not enter model input; the protocol transport owns request-prefix serialization. A catalog change to a model's system prompt mode changes how later system prompt updates are serialized.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The listing cache lives in memory; a start without network serves bundled capabilities until a listing loads.
- A listing change during a running process reaches the Web model picker at its next catalog refresh; the plugin does not announce it.
- The gate runs in this client; a modified client can still request any id unless the service rejects it.
- The listing's effort levels are ignored.
- When the current version can serve no listed model, the account offers no models, and model selectors show their generic empty state rather than an upgrade prompt.
- An override can set but not remove `systemPromptUpdate` and `toolUpdate` declarations.

<a id="dev-note"></a>
### Dev Note

Registration and authentication tests also cover the Loader composition in the shared transport package.
