# Agent Note: Credential records and authorization flows

Status: implemented

English | [中文](2026-08-13-credential-records-and-authorization-flows.zh.md)

## Problem

The harness credential plane could only express one kind of secret: a value behind an environment-variable name. `CredentialRef` is a POSIX identifier, resolution layers the process environment over a managed file and `.env` fallbacks, and every consumer reads it per operation. That covers an API key exactly and covers nothing else.

Some credentials are not values a deployment can be told to store. They are obtained — by a conversation with a human who opens a page, approves an account, and pastes a code back — and what comes out is a token document with a refresh half that rotates behind the user's back. pi-ai models this directly (`Credential = ApiKeyCredential | OAuthCredential`, an app-owned `CredentialStore`, `Models.login()`), and the harness had nowhere to put any of it. `PiAiAdapter` built its collection with `createModels()` and no options, so the store was pi-ai's in-memory default: empty at every boot, discarded on every configuration change. `openai-codex`, whose only method is OAuth, therefore failed every request with `Provider is not configured` — [withheld from the directory](../../archived/bug-fix/2026-08-13-oauth-only-providers-withheld.md) as a release fix, which removed the broken offer without adding the capability.

Two further gaps followed from the same missing plane. A provider's own ambient discovery ran against the raw process environment, so a key held by the credential seam was invisible to it and a local credential file was never even looked for. And a login had no surface to run from, because nothing in the harness could ask a human a question on a plugin's behalf.

## Decision

Three seams, each owning one question, and every pi-ai concept behind an adapter inside `llm-pi-ai`.

**`dsh-credentials` grows a second key space.** A `CredentialRef` answers *what is behind this environment-variable name*; a `CredentialKey` answers *what credential does this plugin hold for this id*. The record union is `{ kind: 'api-key', key?, env? } | { kind: 'grant', payload }` — the api-key half structural because the seam can describe it, the grant half opaque because a library that owns a token format keeps owning it. The only constraint on a payload is that it survives a JSON round trip, enforced on the way in and on the way out.

The key is `<scope>/<id>` where the scope is the **owning plugin's registered name**, not the provider's. A user knows `openai-codex`; which adapter family answers for the bytes inside that record is exactly what a bare provider name loses. Two plugins serving the same provider name would read each other's payload, and a record left by an uninstalled plugin could not be told from a live one. The `/` also keeps the two grammars disjoint, so the key spaces cannot collide. This assumes one adapter registers a given provider route, which the LLM registry already enforces.

Records do not layer. There is no environment an authorization grant could be read from, so presence of the record is the whole fact, and the empty-value rule that governs references does not apply: an `api-key` record carrying neither a key nor env states that its owner confirmed ambient authentication, which is configured.

**`dsh-authorization` owns the conversation, never the protocol.** A plugin that knows how to obtain its own credential registers a flow under the `CredentialKey` that flow writes. The seam runs one attempt per key, routes a neutral vocabulary of notices and prompts, and settles. A second authorization protocol arrives as another flow rather than as another seam, and a surface that renders one flow renders all of them.

Two choices carry the weight:

- **The flow owns the write.** `run()` resolving means the record is already committed through `ctx.credentials`; the seam confirms a commit it observed during the attempt — presence alone would let a re-authorization pass a stale record off as fresh — and refuses a flow that resolved without one. This is what lets `Models.login()` — which persists through the store adapter as part of logging in — stay the single writer, instead of the credential being copied back out and written a second time.
- **The interaction travels with the request, not a registry.** Whoever starts an authorization is the one who can talk to the human about it, so prompts reach exactly the page that asked, a headless caller supplies an interaction that declines, and there is no ambient provider to be absent or ambiguous between two open tabs.

**`llm-pi-ai` holds all three translations.** `credentialStoreFrom` maps pi-ai's `CredentialStore` onto records; `authContextFrom` answers pi-ai's ambient questions from the credential seam, then the launch environment, with file existence checked against the host process's filesystem; `registerPiAiFlows` restates pi-ai's `AuthEvent`/`AuthPrompt` in the neutral vocabulary and runs `Models.login()`. Every collection is built with the first two, which is what keeps a signed-in provider signed in across the collection rebuild a configuration change causes. With a posture that works, the directory stops withholding OAuth-only routes and `openai-codex` is offered again.

The credential plane stays optional, as it already was for reference resolution. Reads answer "nothing stored" without a credentials service, because such a composition genuinely holds no credential; writes refuse by name, because a login whose grant evaporated would report success and then fail every request. Flow registration is scoped to the authorization seam through `ctx.inject`, so a headless or ACP composition mounts with no sign-in and nothing else changed.

### Two mechanisms the seams needed underneath

`withFileLock` takes a per-call wait limit. pi-ai runs an OAuth refresh *inside* `credentials.modify()`, so the record write path holds the lock across a network round trip; the 2s default was chosen for a render-and-rename and would fail every other writer of the document. The retry cadence stays fixed — that is a protocol constant — while the wait is sized by the longest holder a contender can meet: refs and records share one file and one lock, so every writer of the document (`DOCUMENT_LOCK_WAIT_MS`, reference writes and record deletes included) waits an OAuth refresh out, not only the mutation that runs one.

The seam's edges get the same discipline as its write path. A prompt decline is an outcome, not a breakage — an interaction rejects with `AuthorizationDeclinedError` and the attempt settles `cancelled` — while a notice a surface cannot render is logged and lost rather than failing the flow, and `authorization/settled` fans out with contained listener failures on the credentials seam's terms. On the store side, an api-key record is admitted before it is rendered (what `parseRecord` refuses at the next boot is refused at the write), and `llm-pi-ai` asks `isCredentialKeySegment` before addressing a record, so an arbitrary hand-declared route key reads as "nothing stored" instead of throwing mid-resolution.

Withdrawal settles an attempt whether or not its flow reacts to the signal. A flow is supposed to stop when its signal fires, but one that does not would hold its key for the life of the process, and a wedged key is indistinguishable from a busy one from outside. The orphaned run is left to finish on its own.

## Alternatives considered

- **Putting the pi-ai `CredentialStore` shape into the seam itself.** It is the shape that works and it is already designed. It also names `api_key`/`oauth` as the world's two credential kinds and keys by provider id, which is the ownership loss above; a second adapter family would have to pretend to be pi-ai to participate. The record union is deliberately one step more abstract in exactly two places — the key, and the opacity of a grant.
- **A dedicated login-interaction seam beside `user-questions`.** Authorization prompts look like questions, and reusing `ctx.userQuestions` was tempting. But that seam is built for a model's tool call to pause on an agent's behalf: it validates the calling agent, refuses a delegated caller, and has one ambient UI provider. An authorization prompt has no agent, must reach the configuration page that started it, and can be withdrawn per prompt by a browser callback winning a race. The vocabularies overlap; the lifecycles do not.
- **Reading `~/.codex/auth.json` into a store.** It makes Codex work without any of this, and pi-ai would own the refresh. It also binds the harness to another tool's private file format for one provider, and leaves every other login unbuilt.
- **Joining a second `begin()` to the attempt already running.** Friendlier than refusing, until two humans are answering the same flow's questions. Refusal with `inFlight` on the entry lets a surface disable the button rather than discover the state by error.
- **Keeping the OAuth-only withholding as a safety net.** It would now hide a provider that works. The predicate is deleted rather than left inert; `docs/subsystems/credentials.md` and the package READMEs carry what replaced it.

## Consequences

`.credentials.yaml` gains a version and two sections. A boot upgrades the recognized pre-release flat layout in place — an all-string flat mapping nests verbatim under `refs:` under the writer lock — because a key stored through the Models page by an earlier internal build must survive the layout change without a hand edit and without its model requests failing. Any flat shape the recognizer cannot prove it understands keeps the by-name refusal with the hand migration stated in the message; the parser itself still reads exactly one layout, and the migration step retires with the pre-release stance at the first tagged release. Every fixture in the repo that wrote the flat document was rewritten; the llm suites' fixtures were missed by the record change itself and fixed here.

`openai-codex` returns to the provider picker and to the Models page directory. All 38 installed providers offer sign-in: 31 collect a key through pi-ai's own prompt, six offer that beside a subscription login, and Codex offers only the subscription login.

What this does not yet include is the surface: the wire contract that carries notices and prompts to the browser, and the Models-page control that starts a login. Until that lands, the flows are reachable only in-process, and a deployment still configures a key by typing it into the settings form.

Two limits are recorded in the package READMEs rather than fixed. An attempt is not durable, so reloading the page mid-login abandons it. And signing out is `deleteRecord`, which forgets the record locally without telling the issuer; a provider needing a server-side revoke has nowhere to declare it.

## Testing

The seam's suite pins the lifecycle it owns: single-flight refusal and release, withdrawal before the flow starts and during it, a flow that ignores its signal, the commit confirmation, and the settlement event including the `failed` case a caller sees as a thrown error. The invariant companion pins that a settled key is a free key, because a wedged one is otherwise invisible.

`llm-pi-ai` covers the three translations against a real `$DSH_HOME` document — an api-key credential field by field, an OAuth credential verbatim including its refresh half, a foreign plugin's record skipped by scope, and the write refusal without a credentials service — plus every `AuthEvent` and `AuthPrompt` member restated, with `Models.login()` mocked at the collection boundary since a real one opens a browser. Two real-composition tests boot the plugin with and without the authorization seam.

The `models-settings` and `onboarding-usable-provider` web e2e goldens regain exactly the `openai-codex` option line they lost when it was withheld — the only assembled-application difference this decision records, because the Models page has no login control yet to record.
