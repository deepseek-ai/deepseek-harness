---
description: "DeepSeek API-key authentication, model discovery, and the official model listing."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek-api-key

English | [中文](README.zh.md)

## Summary

Register authentication, model discovery, and the official model listing for `deepseek-official`. This plugin shares the [Messages transport](../llm-deepseek/README.md) and owns credential resolution, catalog availability, and model admission.

Authentication resolution returns the validated API key in `x-api-key` for both Messages and Files requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

`apiKeyEnv` defaults to `DEEPSEEK_API_KEY` and resolves per request and model discovery. When the credentials service exists, its precedence applies; only compositions without that service read the launch environment directly. Requests with missing credentials fail with `MISSING_CREDENTIAL`; malformed credentials fail with `INVALID_CREDENTIAL`. Model discovery returns an empty catalog when the credential is missing, hiding the route from model selectors while retaining its settings entry. Malformed credentials and other lookup failures propagate. Adding or removing a key affects the next discovery call.

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    reasoningEffort: high
    apiKeyEnv: DEEPSEEK_API_KEY
```

The endpoint and credential reference come from one configuration resolution. In-flight requests retain that snapshot; subsequent updates affect subsequent calls. Account login state cannot change this route’s credential.

`models` is an independently configurable catalog for this provider; defaults and protocol capabilities come from the shared transport. While `models` equals the built-in catalog and the Messages origin is the official API, `https://api.deepseek.com`, the route serves the official `GET https://api.deepseek.com/models` listing instead. Listing requests carry the API key in `x-api-key` and the harness `User-Agent`, and reject redirects; without an API key the route requests nothing. Any other endpoint, including one named by `baseURL` or `$DEEPSEEK_BASE_URL`, serves `models` and requests no listing. Discovery does not probe inference endpoints.

The first access waits for the listing up to `modelsTimeoutMs`. Later accesses use the loaded listing and refresh it in the background once it is older than `modelsMaxAgeMs`; an idle route sends no requests. A failed or empty listing keeps the previous one; before any listing loads, the route serves the built-in catalog of the current version (`deepseek-flash` and `deepseek-v4-pro`). A listing HTTP 401 fails only that load. Each loaded listing, the first failure of a failing streak with the catalog it falls back to, and each listing entry hidden because its declarations are unreadable or unusable are written to stderr with the `[llm-deepseek-api-key]` tag; stdout remains available for protocol messages, and secrets are never logged.

Listed models are offered, merged with this build's entries, and refused before network I/O with `CLIENT_UPGRADE_REQUIRED` or `MODEL_UNSUPPORTED` by the [account route's rules](../llm-deepseek-account/README.md#use-this-package); model ids the listing does not name pass through unchanged.

A `models` list that differs from the built-in catalog replaces the catalog and stops listing requests; the Models page stores an edited catalog there. Removing that list, as **Restore defaults** on the Models page does, returns the route to the listing, and the next access loads the listing again even when the cached one is still fresh. A list identical to the built-in catalog counts as uncustomized.

| Field | Default | Meaning |
|---|---|---|
| `modelsTimeoutMs` | `5,000` | Deadline of one listing request and of a first-access wait |
| `modelsMaxAgeMs` | `600,000` | Listing age after which the next access refreshes it; a failed load retries after the same age |

The settings namespace is the Cordis entry id, or the plugin name without an entry. Product profiles retain the official entry id `llm-deepseek` and use `llm-deepseek-account` for the account route.

<a id="understand-the-implementation"></a>
## Understand the implementation

Registrations and listeners dispose with the plugin, and disposal aborts an in-flight listing request. Shared Host wiring supplies attachments, request extensions, anonymous identity, and atomic retry-policy updates; this plugin registers only its own route and uses the transport's `connect` and `admit` hooks for the listed catalog and the gate. The listing request, its cache, and catalog resolution come from the shared transport; the cache lives in memory and is keyed by endpoint and a SHA-256 of the key, so another key loads its own listing. A `loader/volatile-update` listener discards the cached listing whenever the route starts or stops following it.

<a id="further-exploration"></a>
## Further Exploration

[LLM streaming](../../../docs/subsystems/llm-streaming.md) · [Messages](../llm-deepseek/README.md) · [Official listing decision](../../../.agents/notes/implemented/architecture/2026-10-22-deepseek-official-model-listing.md)

<a id="model-experience"></a>
## Model Experience

### Authenticated model requests

#### What the model sees

Requests on `deepseek-official` add no model-visible text from this plugin; the shared Messages transport serializes requests.

#### Token effect

Authentication, discovery, and the listing add no input tokens. The followed listing sets each model's context window and default output cap, which each request's logged context and header record.

#### KV Cache effect

Credentials and catalog availability do not enter model input; the protocol transport owns request-prefix serialization. A listing change to a model's system prompt or tool update mode changes how later system prompt or tool updates are serialized.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A configured catalog is configuration metadata, not remote validation that a model is accepted; actual calls can still fail.
- The Models page shows the built-in catalog while the route follows the listing, so a model only the listing offers appears only in model selectors. Editing that catalog on the page stores the rows the page shows, which drops such a model until **Restore defaults**.
- A customized catalog does not receive models the listing adds later.
- Customization is judged against the running version's built-in catalog, so a saved `models` list equal to an earlier version's built-in catalog counts as customized once the built-in catalog changes and stops following the listing until **Restore defaults**.
- The listing cache lives in memory; a start without network serves the built-in catalog until a listing loads.
- A listing change during a running process reaches the Web model picker at its next catalog refresh; the plugin does not announce it.
- When the current version can serve no listed model, the route offers no models.

<a id="dev-note"></a>
### Dev Note

Registration and authentication tests also cover the Loader composition in the shared transport package.
