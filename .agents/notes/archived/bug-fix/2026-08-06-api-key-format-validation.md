# Agent Note: Validate API key format before it reaches an HTTP header

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-api-key-format-validation.zh.md)

## Problem

An API key holding characters no HTTP header value can carry was accepted by every configuration surface and failed only when a request was built, far from the field that caused it.

Pasting a key containing an emoji, CJK text, or a full-width punctuation mark into the web Models page reported a successful save. The first turn then failed with `Cannot convert argument to a ByteString because the character at index 7 has a value of 55357 which is greater than 255` — the index and code point are UTF-16 internals with no action attached, and they disclose the code point of one character of the key. `llm-deepseek` produced this because `fetch` builds the `Bearer` header inside the `try` in [adapter.ts](../../../../packages/llm/llm-deepseek/src/adapter.ts), whose `catch` labels every failure `TRANSPORT`; that label is in `DEFAULT_RETRYABLE_CODES`, so a permanent, deterministic fault was also retried three times.

`llm-pi-ai` was worse on the same input. Its discovery probe builds the same header with a bare `fetch` in [discovery.ts](../../../../packages/llm/llm-pi-ai/src/discovery.ts) and wrapped every failure as `could not reach <url>`, so a local key fault was reported as an unreachable network. The probe is reachable from the unsaved draft: `ProviderEditor` puts the typed `keyDraft` into its probe request, so the model-listing button sent an illegal key before anything was stored.

Whitespace passed every check. `ProviderEditor` tested `keyDraft.length`, so a key of three spaces was stored and then authenticated as `Bearer` plus blanks. Neither adapter checked a credential- or environment-sourced key — the path the Models page writes, and therefore the path users actually take.

## Decision

One rule defines a legal key: **after trimming, non-empty, and every character within `[\x21-\x7E]`** — printable ASCII, space excluded.

This single predicate covers every reported input: empty, leading and trailing whitespace, interior whitespace, C0 control characters, emoji, CJK text, and full-width punctuation. It is also exactly the constraint that produced the ByteString failure, so the failures share one definition rather than two coincidentally related fixes.

A second, narrower rule catches a pasted environment line: input matching `^[A-Z][A-Z0-9_]*=[^=]` or wrapped in matching quotes is refused. Restricting the prefix to upper-case keeps real keys clear of it — `sk-` forms break the identifier match at the hyphen — and requiring a non-`=` character after the separator keeps base64 padding clear of it too. It reports the same format failure as an illegal character rather than its own message: the reader's next move is identical either way, so a separate line would name a cause without changing what to do.

### Invariants belong at every layer; heuristics belong where the human is

The charset rule is an invariant. A non-ASCII character *cannot* travel in a header value for any provider, so enforcing it in the browser, in each resolver, and on every credential read is consistent by construction rather than by agreement.

The shape rule is a guess about how people paste, so it runs **only in the browser**. `llm-pi-ai` fronts OpenAI, Anthropic, and arbitrary hand-declared gateways whose key formats this repository does not own; a gateway issuing a key shaped like `TENANT1=abc` would, if the rule ran in the resolver, be locked out with no escape — the settings page would refuse it and a hand-written `.env` would be rejected on read. Confining the heuristic to the surface where the paste happens keeps the environment as the way through.

### Absence is a configuration state, not a missing key

The rule applies to a value that was *provided*; deciding whether one was provided at all stays with each caller.

**No named credential.** A pi-ai profile omitting `apiKeyEnv` may authenticate outside the harness-held credential path. `routeAuth` in [provider.ts](../../../../packages/llm/llm-pi-ai/src/provider.ts) keeps the installed catalog provider's own auth precisely so provider-native ambient discovery survives, and `openai-codex` — shipped in that catalog — authenticates through OAuth. `namesCredential` carries this distinction; omission is not a value to validate.

**A blank field in the web UI.** The key input opens empty even for a provider whose key is already stored — the `keyStored` copy reads "Configured — enter a new value to replace" — so blank means *keep what is stored*. `ProviderEditor` skips `credentials.set` entirely when the draft is empty, and that stays a no-op: a blank field never blocks submit, or editing a base URL would demand re-entering the key.

**A resolved value that is whitespace-only.** This is invalid at both adapters because it cannot authenticate a request. In the browser it is also a field-level failure: the field is where a person just typed, and silently discarding what they typed is never the right answer.

`normalizeApiKey` therefore takes `string`, never `string | undefined`.

### Where the rule lives

`normalizeApiKey` is a module of the `dsh-llm` Service Definition, beside [attribution.ts](../../../../packages/llm/llm/src/attribution.ts), which already owns shared header concerns. Both adapters depend on the seam and both need the rule, so it has two current consumers rather than a speculative one. It returns the trimmed value or a reason (`empty`, `illegalCharacters`).

Both adapters also need the identical "refuse a stored credential" diagnosis, differing only by package prefix. `LlmError` is declared in the Service Definition's `index.ts`, so `assertUsableApiKey(raw, pkg, ref)` lives there beside it and neither adapter carries a local copy. The predicate module stays dependency-free: importing `LlmError` into `api-key.ts` would cycle with `index.ts`'s re-export of it.

The client cannot import any of this: client packages reference only client packages, so `packages/client/ui-settings-models` mirrors the predicate in its own `apiKey.ts` and owns the localized messages, exactly as `validateDeepSeekModels` mirrors the host's `catalogModel` schema. Each side names the other in a comment.

### What each surface does

| Surface | Behavior |
|---|---|
| `dsh-llm` | Owns `normalizeApiKey`, `assertUsableApiKey`, and `INVALID_CREDENTIAL_CODE`, which is deliberately outside `DEFAULT_RETRYABLE_CODES`. |
| `llm-deepseek` `resolveApiKey` | Normalizes what the credentials seam or environment returns, rejecting with `INVALID_CREDENTIAL` naming the Models page and never echoing the key. |
| `llm-pi-ai` `resolveApiKey` | Normalizes the credential and environment paths. A profile naming no credential still returns `undefined`, so ambient and OAuth routes are unaffected. |
| `llm-pi-ai` `discoverModels` | Normalizes before building the header, so an illegal key is a credential fault rather than an unreachable endpoint. A probe carrying no key stays unauthenticated. |
| `ui-settings-models` | Mirrors the charset rule, adds the shape heuristic, trims `keyDraft` before probe and `credentials.set`, and fixes the `stringAt` emptiness test. A blank field remains a no-op that submits; a field holding only whitespace is a field-level failure. Submit **and the endpoint interrogation** are both gated, so a refused key never spends a round trip to be told what the field already says, and the failure renders on the field, matching the existing `modelFailure` pattern. |

`ProviderEditor` serves both the DeepSeek and pi-ai layouts, so one client change covers both providers. `CustomProviderCard` carries the same judgement for a hand-declared route.

`credentials-local` is deliberately untouched. It stores credentials generally, and printable-ASCII is a constraint of HTTP headers rather than of credential storage; its existing refusal of values no dotenv style can represent stands as it was.

## Alternatives considered

**A validation module shared by client and host.** Rejected by the source-plane layout: client packages reference only client packages plus `vendor/cordis` and `runtime-diagnostics/invariants`, and widening that to reach a host package would collide the two `Context` merges the split exists to keep apart. Mirroring a one-line predicate with a test on each side is the established shape here.

**A per-adapter thrower in each of `llm-deepseek` and `llm-pi-ai`.** The first plan gave each adapter its own, differing only by the package prefix in the message, with a duplication-gate exemption to excuse the pair. Rejected before implementation: `LlmError` is declared in the Service Definition, so that package can own the diagnosis outright, and an exemption there would have hidden exactly the duplication it was covering for.

**Sniffing the `TypeError` in the adapter's `catch`.** This would classify the ByteString failure after the fact, leaving the header construction itself unguarded. It depends on the wording of a Node error message, so it degrades silently across runtime versions, and it cannot help `llm-pi-ai`, whose request header is built inside the pi-ai SDK. Refusing the key before handing it over works for both adapters and for the discovery probe.

**Enforcing in `credentials-local.set`.** It would catch every writer at once, including a hand-edited file. It lost because that provider stores credentials of every kind, and a rule derived from HTTP header encoding does not belong to it.

**Running the shape heuristic in the resolvers too.** Symmetric, and it would stop a pasted environment line written directly into `.env`. Rejected for the lockout described above: a false positive in a resolver leaves the user no working path, while a false positive in the browser leaves the environment open.

**Probing the provider at save time to prove the key works.** It would close the original complaint — a save that reports success and fails at the first turn. Rejected as out of scope and, on the code as it stood, unbuildable: `discoverModels` short-circuits to the installed catalog before any network call for exactly the providers pi-ai ships catalogs for, so it verified nothing about the key, and the DeepSeek card has no probe at all. A verifier's value is distinguishing "key rejected" from "cannot reach", which is the distinction this change makes reliable; building it first would have produced a verifier unable to tell its own outcomes apart. Comparable products also do not verify on save, so a blocking network call there would be an unexpected behavior rather than a missing one.

## Consequences

A malformed key is refused at the field that holds it, and a malformed stored key fails as `INVALID_CREDENTIAL` with a message naming where to fix it and no fragment of the key. Because that code sits outside `DEFAULT_RETRYABLE_CODES`, a deterministic credential fault is no longer retried three times as a transport blip. `llm-pi-ai` discovery reports an illegal probe key as a credential fault instead of an unreachable endpoint.

The shape heuristic can refuse a real key. Matching any upper-case identifier followed by `=` would be broader than intended: an all-upper-case base64 key ending in padding (`ABCD==`) would match an assignment it does not resemble. Requiring a non-`=` character after the separator excludes padding, since base64 only ever pads at the end. What remains — an upper-case name, one `=`, then a value — is a shape no known provider issues, and the rule runs only in the browser, so a user who still hits it can set the credential through the environment. The residual cost is a confusing refusal for a key nobody has yet reported.

Restricting to printable ASCII is stricter than the transport requires: a header value may carry `\x80`–`\xFF`. Admitting latin-1 would let `é` through to return an opaque 401 instead of a local, explained refusal, so the stricter rule is deliberate. A provider that issues latin-1 keys would need this rule widened.

The charset predicate exists twice, once per source plane. The layout forbids sharing it; each side carries its own test and names its twin.

Keys already stored by an earlier build are read through `resolveApiKey`, so an illegal stored value fails at resolution rather than at request time. The diagnosis improves, but the failure moves earlier for anyone currently holding one.

The costliest way to get this wrong would have been to treat absence as invalidity: a rule applied to `undefined` breaks every route authenticating through ambient discovery or OAuth, and a blank field that blocked submit makes editing any other setting demand re-entering the key. Both are pinned by tests rather than left to care.

## Testing

`packages/llm/llm/tests/api-key.spec.ts` drives `normalizeApiKey` and `assertUsableApiKey` over the whole input table — empty, whitespace-only, padded, interior-space, C0 control, emoji, CJK, full-width, latin-1, and the printable-ASCII boundary — and pins that a refusal carries `INVALID_CREDENTIAL` and no part of the key.

`packages/llm/llm-deepseek/tests/` covers the stored-credential path end to end in `dynamic-config.spec.ts`, through the real credentials seam rather than a stub. `packages/llm/llm-pi-ai/tests/` covers the discovery probe, including that a probe with no key sends no `authorization` header.

`packages/client/ui-settings-models/tests/` pins `apiKeyFailure` over the same table plus the paste-shape cases, and drives both cards: a blank field submits without writing a credential, a whitespace-only field fails on the field, an illegal or wrapped key blocks submit and the interrogation alike, a padded key is trimmed before `credentials.set` and before an interrogation, and a hand-declared route can be created with no key at all.

The user-visible terminal state is pinned where it is actually assembled: `apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts` runs the one-shot app against a stored key no header can carry, over the same keyless composition its missing-credential sibling uses, and records that the turn ends on `INVALID_CREDENTIAL` with an actionable message carrying neither the key nor the word `ByteString`. A package test could not have shown that, and the web e2e covers only the browser half.
