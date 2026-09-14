---
description: "The authorization flow registry for users and maintainers who obtain credentials that configuration cannot supply, because getting one means a conversation with a human."
kind: "package-reference"
---

# @deepseek-ai/dsh-authorization

English | [中文](README.zh.md)

## Summary

`dsh-authorization` lets a configuration UI or another caller obtain credentials through a human-guided sign-in, code entry, or question. Each attempt sends notices and prompts only to the surface that started it. It reports `authorized` only after the new credential has been stored; a refusal or withdrawal reports `cancelled`, while failures remain errors. Choose it for credentials that cannot be supplied through configuration. It requires the credential store and an integration that defines the available authorization methods; the package provides no provider-specific methods itself.

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

This package is the part of the product that obtains credentials a human must hand over: a plugin registers the flow that knows how to get its own credential, and any surface can run an attempt and show the human what to do. The common path is explicit — register a flow for each credential your plugin holds, then start attempts from the surface the human is looking at.

### When to use it

Use it whenever a credential can only be obtained by talking to a human — an OAuth-style sign-in, a one-time code, an account pick — and cannot be stored in configuration. If a credential is a fixed key a deployment can supply, store it with the credential seam instead. A headless or ACP composition can mount this package safely: it offers no flows of its own, so nothing asks a human to sign in unless a plugin registered a flow.

### Registering a flow

Your plugin declares one flow per credential it holds, keyed by the `<scope>/<id>` credential record the flow writes — the scope names your plugin, the id names one credential it owns:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context
declare const exchangeCode: (code: string, signal: AbortSignal) => Promise<{ token: string }>

const key = credentialKey('llm-pi-ai', 'openai-codex') // <scope>/<id> — your plugin / this credential

const dispose = ctx.authorization.registerFlow({
  key,
  label: 'ChatGPT (Codex)',
  methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
  async run(session: AuthorizationSession) {
    session.notify({ message: 'Continue in your browser', url: 'https://auth.example/start' })
    const code = await session.prompt({ kind: 'text', message: 'Paste the code' })
    const { token } = await exchangeCode(code, session.signal)
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { token } }))
  },
})

ctx.authorization.list()          // every registered flow, with inFlight
ctx.authorization.describe(key)   // the entry above, or undefined
dispose()                         // unregister; withdraws any running attempt
```

A flow declares the credential record it writes, a user-facing label, and the sign-in methods it offers, most preferred first. `run()` talks to the human through the session — one-way notices and questions the flow cannot answer for itself — and must commit the record through `ctx.credentials` before resolving: the seam refuses a flow that resolved without committing. `list()` and `describe()` let a surface show what can be authorized and whether an attempt is running; `dispose()` unregisters the flow and withdraws any attempt still running.

### Running an attempt

A surface runs one attempt per credential at a time. The interaction travels with the request rather than living in a registry, so prompts reach exactly the page that asked; a headless caller supplies an interaction that declines. `begin()` reports `{ status: 'authorized' }` when the record was committed and observed during the attempt, and `{ status: 'cancelled' }` when the human declined or the caller withdrew. `cancel(key)` withdraws the running attempt from a second call, for the request/response transport that answers a Cancel button without holding the first call's signal.

### What can go wrong

- **A credential with no flow is inert** — `begin()` on a key no flow claims throws `NO_FLOW`; a record left by an uninstalled plugin can be deleted but not re-authorized.
- **One attempt at a time per credential** — a second `begin()` while one is running throws `ALREADY_IN_FLIGHT`; `inFlight` on the entry lets a UI disable the button up front.
- **A flow that resolves without committing is refused** — `NOT_COMMITTED`, so `authorized` always means the record is really stored.
- **Naming a method the flow does not offer throws `UNKNOWN_METHOD`** — naming none runs the flow's first method.
- **"No" is an outcome, not a breakage** — a declined prompt settles the attempt as `cancelled`, the same as a withdrawn signal; any other failure reaches the caller as a thrown error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the seam and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **The seam owns the conversation, never the protocol.** A plugin that knows how to obtain its own credential registers a flow keyed by the record it writes; a second authorization protocol arrives as another flow rather than another seam, and a surface that renders one flow renders all of them.
- **The flow owns the write.** `run()` resolving means the record is already committed through `ctx.credentials`; the seam confirms a commit it observed during the attempt — presence alone would let a re-authorization pass a stale record off as fresh — and refuses a flow that resolved without one. Committing inside the flow is what lets a library that persists through its own store adapter stay the single writer instead of being copied back out and written twice.
- **The interaction travels with the request, not a registry.** Whoever starts an authorization is the one who can talk to the human about it, so prompts reach exactly the surface that asked, and a headless caller supplies an interaction that declines. There is no ambient provider to be absent, and no question about which of two open pages a prompt belongs to.
- **A human's "no" is an outcome, not a breakage.** An interaction that declines rejects its prompt with `AuthorizationDeclinedError`, and the attempt settles as `cancelled`, exactly as a withdrawn signal does; any other prompt rejection stays a flow failure that reaches the caller.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition: flow registry, one-attempt-per-key lifecycle, interaction routing, commit confirmation |
| [`src/types.ts`](src/types.ts) | Wire-safe vocabulary: methods, notices, prompts, outcomes, entries |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: `authorization/settled` always names a released key |

### Lifecycle

One attempt per key at a time. `begin()` validates the key and method, refuses a second attempt for a busy key, and runs the flow with an `AuthorizationSession` that carries the chosen method, a cancellation signal, and the `notify`/`prompt` callbacks routed to the request's interaction. A withdrawn attempt settles immediately even when the flow never reacts to its signal — the orphaned run is left to finish on its own, and a record it still manages to commit is a record the human did authorize. The key is released before `authorization/settled` fires, so a listener that reacts by starting the next attempt is not refused; listener failures are contained on the credentials seam's terms.

### The interaction vocabulary

A notice is one-way and never carries a secret: a message, optionally the page the human must open and the code they must enter there. A prompt is a question the flow cannot answer for itself — `text`, `secret`, or `select` — where `secret` differs from `text` only in presentation. A prompt carries its own signal so a flow that races a typed code against a browser callback can withdraw the losing question while the attempt continues; the request's signal withdraws the whole attempt instead. The vocabulary is deliberately smaller than any one provider's: it describes what a surface must render, so a surface that renders one flow renders all of them.

### Commit confirmation

During the attempt the seam watches `credentials/record-updated` for the flow's key, then after `run()` resolves it re-reads `describeRecord` — confirming the commit happened now, because on a re-auth the record already exists and presence alone would let a stale credential pass as freshly authorized. A flow that resolves without committing, or that deleted its record instead of committing one, throws `NOT_COMMITTED`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared credential vocabulary to the record store the flows write through and the decision evidence behind the seam.

- [Credentials subsystem reference](../../../docs/subsystems/credentials.md) — the two key spaces and the generated cordis surface for both seams.
- [Credentials package map](../README.md) — the credential-reference, local-store, and authorization packages.
- [Credential-reference seam](../credentials/README.md) — the record store every flow commits through.
- [Capability seams](../../../docs/capability-seams.md) — the Service Definition / Service Provider / Consumer split this seam follows.
- [Credential records and authorization flows](../../../.agents/notes/implemented/architecture/2026-08-13-credential-records-and-authorization-flows.md) — the rationale and decisions behind the record half and this seam.

-----

<a id="model-experience"></a>
## Model Experience

None, as authorization is a configuration-time conversation with a human and no flow, notice, or prompt reaches a model request.

#### KV Cache effect

No invalidation; no authorization state enters a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **No flow is resumable** — an attempt lives in the process that started it, so a browser reload during a login abandons it and the human starts over; durable attempts need a store this seam does not have.
- **Nothing revokes** — signing out is `ctx.credentials.deleteRecord(key)`, which forgets the local record without telling the issuer; a provider that needs a server-side revoke has no place to declare it.
- **A key with no flow is inert** — the seam reports what is registered, so a record left by an uninstalled plugin can be deleted but not re-authorized; recognizing that orphan is the caller's job, as it is for `listRecords()`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

The limitations above name the open directions — resumable attempts, server-side revocation, orphaned-record discovery — each needing its own design and store before landing. The invariant companion is the one load-bearing runtime check: settlement must always find the key released, because a wedged key is indistinguishable from a busy one and only a restart frees it.

</details>
