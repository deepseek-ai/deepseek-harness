---
description: "DeepSeek account authentication and model discovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek-account

English | [中文](README.zh.md)

## Summary

Register authentication and model discovery for `deepseek-account`. This plugin shares the [Messages transport](../llm-deepseek/README.md) and owns credential resolution and catalog availability.

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

Only `deepseekAccount.resolveToken(baseURL)` supplies the token; the account service validates the destination. Signed-out or ineligible requests fail with `ACCOUNT_SIGN_IN_REQUIRED` and discovery returns an empty catalog. The route never falls back to an API key. Other credential lookup errors propagate.

```yaml
- id: llm-deepseek-account
  name: '@deepseek-ai/dsh-llm-deepseek-account'
  config:
    reasoningEffort: high
```

An account request HTTP 401 maps to `ACCOUNT_TOKEN_INVALID` independently of the response body. The account service removes the credential only if it still matches the request token. HTTP 403 and other failures do not clear the login. The account module owns task cancellation after sign-out; this plugin does not inspect Agents.

`models` is an independently configurable catalog for this provider; defaults and protocol capabilities come from the shared transport. Discovery does not probe inference endpoints. The settings namespace is the Cordis entry id, or the plugin name without an entry. Product profiles retain the official entry id `llm-deepseek` and use `llm-deepseek-account` for the account route.

<a id="understand-the-implementation"></a>
## Understand the implementation

Registrations and listeners dispose with the plugin. Shared Host wiring supplies attachments, request extensions, anonymous identity, and atomic retry-policy updates; this plugin registers only its own route. No invariant companion is published: discovery derives directly from configuration and credentials without an independent copy.

A failed request the shared transport classifies as `QUOTA` is rewritten to `ACCOUNT_QUOTA` before it leaves this provider, covering an HTTP 402 response and an in-band SSE error alike. The shared transport and the `deepseek-official` route keep `QUOTA`, so the account route's top-up action never appears for an API-key or third-party failure.

<a id="further-exploration"></a>
## Further Exploration

[LLM streaming](../../../docs/subsystems/llm-streaming.md) · [Messages](../llm-deepseek/README.md)

<a id="model-experience"></a>
## Model Experience

### Authenticated model requests

#### What the model sees

Requests on `deepseek-account` add no model-visible text from this plugin; the shared Messages transport serializes requests.

#### Token effect

Authentication and discovery add no input tokens; the selected model and request content determine actual usage.

#### KV Cache effect

Credentials and catalog availability do not enter model input; the protocol transport owns request-prefix serialization.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The catalog is configuration metadata, not remote validation that a model is accepted; actual calls can still fail.

<a id="dev-note"></a>
### Dev Note

Registration and authentication tests also cover the Loader composition in the shared transport package.
