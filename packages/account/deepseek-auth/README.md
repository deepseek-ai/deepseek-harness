---
description: "DeepSeek request authentication for plugins that call a DeepSeek API: one service chooses between the API key and the account sign-in, binds the credential to its deployment, and releases the request headers."
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-auth

English | [中文](README.zh.md)

## Summary

`dsh-deepseek-auth` authenticates requests to DeepSeek APIs through `ctx.deepseekAuth`. A consumer names the credential kinds its API accepts, the API key, the account sign-in, or both, and the billing its settings choose. The service orders the kinds, binds each to the deployment its credential belongs to, and releases the headers of the first kind that has a credential. The DeepSeek model routes, the Search and Fetch APIs, Messages search, and the experimental speech recognition provider use it. It stores nothing: keys come from the credential store or the launch environment, and the sign-in from the account service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

A plugin that calls a DeepSeek API asks this service for the credential of one request. The plugin sends the request itself and words its own failures.

### When to use it

Use it for every request a Host plugin sends to a DeepSeek deployment. Mount it in every composition that mounts a DeepSeek model route or a DeepSeek web provider; those plugins require it. It needs no configuration. It reads the credentials service and the account service when they are mounted and works without either.

### Authorizing a request

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-deepseek-auth'

declare const ctx: Context
declare const route: string | undefined // provider route of the conversation's latest model request
declare const signal: AbortSignal

const authorization = await ctx.deepseekAuth.authorize({
  consumer: 'my-plugin',
  accepts: ['account', 'api-key'],
  billing: 'auto',
  route,
  destination: { path: '/v1/tools/search' },
}, signal)
if (authorization === undefined) throw new Error('no DeepSeek credential is configured')
await fetch(authorization.endpoint, { method: 'POST', headers: authorization.headers, signal })
```

`accepts` lists the kinds the destination API accepts; a kind outside it is never tried. When an API starts to accept another kind, its consumer adds that kind to `accepts`, and nothing else changes. `billing` is `api-key`, `account`, or `auto`, which follows the model route of the conversation:

| `billing` | Conversation's model route | Kinds tried, in order |
|---|---|---|
| `api-key` | any | API key |
| `account` | any | account sign-in |
| `auto` | the route connected for the account sign-in, `deepseek-account` | account sign-in, then API key |
| `auto` | the route connected for the API key, `deepseek-official` | API key |
| `auto` | any other route, or no conversation | API key, then account sign-in |

A route belongs to the first two `auto` rows only while the plugin that registers it is mounted and has connected it. A conversation recorded on `deepseek-account` or `deepseek-official` whose plugin is not mounted follows the last row.

`destination` is a path appended to the origin of the chosen kind's deployment, or one absolute `url`. A kind serves an absolute URL only when the URL is under the origin of that kind's deployment and embeds no credentials, so a key is never sent to another origin.

An authorization carries the `kind`, the `endpoint`, and the request `headers`. An API key is sent as `Authorization: Bearer` unless `apiKeyHeaders` names `x-api-key` or both; the account sign-in is sent in the header the account service chooses. `reject()`, present for the account sign-in, invalidates the credential after the destination answered HTTP 401. `revoked`, also present for the account sign-in, aborts when the account signs out: the consumer ends the request it authenticated and reports that end as its own failure, not as the caller's cancellation.

`candidates(request)` returns the same kinds in the same order without reading a credential. Each candidate answers `configured()` for readiness checks and `resolve(signal)` for the credential, and names its `endpoint` and, for an API key, its `reference` for diagnostics. `routeKind(route)` names the kind a mounted model route plugin connected under that route id, and `undefined` for every other route.

### Where each kind's credential and deployment come from

| Kind | With its model route mounted | Without it |
|---|---|---|
| API key | The key reference and base URL of the `deepseek-official` route's settings, which the Models page edits | `DEEPSEEK_API_KEY`, sent to `https://api.deepseek.com` |
| Account sign-in | The account service's credential, sent to the origin of the `deepseek-account` route's base URL | The account service's credential, sent to the origin `DEEPSEEK_BASE_URL` names, the official API by default |

A model route plugin connects the provider route it registers and its settings from within `ctx.effect()`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-auth'

declare const ctx: Context
declare const settings: () => { baseURL: string; apiKeyEnv: string }

ctx.effect(() => ctx.deepseekAuth.connect('api-key', 'deepseek-official', () => {
  const { baseURL, apiKeyEnv } = settings()
  return { baseURL, reference: credentialRef(apiKeyEnv), owner: 'llm-deepseek' }
}))
```

The service calls the function for each request, so a settings change reaches the next request. While the connection exists, `auto` billing orders a conversation on that route by the connected kind. A request can carry its own connection of a kind in `connections`, which replaces the connected or default one: a model route passes the configuration generation it captured for one model request, and a consumer with its own endpoint and key passes those.

A key is read through the credentials service when one is mounted and through the launch environment otherwise, as [`dsh-credentials`](../../credentials/credentials/README.md) defines for references.

### What can go wrong

- `authorize()` returns `undefined` when no candidate has a credential. The consumer words the failure; `candidates()` supplies the kinds and the key reference to name.
- An API key that is blank or holds characters no HTTP header can carry fails with `DeepSeekAuthError` code `INVALID_CREDENTIAL`. The message names the owner and the reference to fix and never the key.
- A kind whose connection does not resolve, because the route's settings throw, a base URL does not parse, or `DEEPSEEK_BASE_URL` is no HTTP(S) URL, appears in `candidates()` as an unresolved entry. `authorize()` stops there with code `UNRESOLVED_CONNECTION` and does not try a later kind.
- A second `connect()` of one kind throws `DUPLICATE_CONNECTION`.
- Credential store failures propagate.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service; the observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

- **Consumers declare what their API accepts; the service chooses.** DeepSeek adds account authentication to its APIs one at a time. A consumer's `accepts` list is the only place that records what one API accepts, so widening it is the whole change when an API gains a kind.
- **A credential is bound to its deployment.** Each kind has one deployment at a time, and a credential is released only for destinations under that deployment's origin.
- **The model routes are consumers.** The route plugins connect their settings and ask for authorization like every other consumer, so the transport and the model service hold no credential interface.
- **The service depends on no consumer.** It reads the credential store and the account service and names no model route: each route plugin passes its own route id when it connects, and `auto` billing compares the conversation's route with the connected ids.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The service: connections, billing order, destination binding, the API-key and account sources, `DeepSeekAuthError` |
| [`src/types.ts`](src/types.ts) | Request, connection, candidate, and authorization types |

### Lifecycle

The service holds only the connections model route plugins registered; each disposer removes one. Nothing else is retained between requests: every `candidates()` call reads the connected settings again, and every `resolve()` reads the credential again.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Account package map](../README.md) — the account service and this service.
- [DeepSeek account subsystem](../../../docs/subsystems/account.md) — the account sign-in and the request credentials this service releases.
- [Credential-reference seam](../../credentials/credentials/README.md) — how a key reference is read and checked.
- [DeepSeek request authentication](../../../.agents/notes/implemented/architecture/2026-11-10-deepseek-request-authentication.md) — the decision and its rejected alternatives.

-----

<a id="model-experience"></a>
## Model Experience

None, as the service releases request headers to Host plugins and contributes nothing to a model request's content. Its consumers word the failures a model reads.

#### KV Cache effect

No invalidation; no credential enters a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this package is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **One deployment per kind** — a second `deepseek-official` style route with its own key and endpoint cannot connect; a consumer that needs another key passes its own connection in the request.
- **A route counts as a DeepSeek route only while its plugin is connected** — a conversation recorded on `deepseek-account` or `deepseek-official` follows the order of other routes, API key and then account sign-in, while that plugin is not mounted, and so does a DeepSeek model reached through another provider plugin.
- **No credential validation** — `configured()` reports presence only, so a wrong key counts as configured until the destination rejects it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

The speech and document APIs under `/v1/tools/` accept only the API key today. Their consumers declare `accepts: ['api-key']` and add `account` when the server accepts the account sign-in.

</details>
