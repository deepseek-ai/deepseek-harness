# Agent Note: The configurable-provider directory withholds OAuth-only providers

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-13-oauth-only-providers-withheld.zh.md)

## Problem

The Models page offered `openai-codex` like any other pi-ai route, with the placeholder every pi-ai provider carries: enter a key, or leave it blank to authenticate from the environment. Configuring it that way and sending a message failed the turn with `Provider is not configured: openai-codex`, reported as the adapter's catch-all `PI_AI_ERROR`.

The posture the placeholder invited could not work on that route. pi-ai's `resolveProviderAuth` reaches an OAuth provider through one path — a credential already in the collection's `CredentialStore` — and has no ambient fallback for it, while `openai-codex` is the one installed provider declaring `auth.oauth` with no `auth.apiKey` beside it. `PiAiAdapter.current()` constructs its collection with `createModels()` and no options, so the store is pi-ai's default `InMemoryCredentialStore`: empty at every boot, and rebuilt from scratch each time a configuration change produces a new snapshot. No code here runs `Models.login()`, and pi-ai's library half does not read Codex's own `~/.codex/auth.json` either — its OAuth module is a PKCE login flow whose credential the *host* application persists, which is what the pi CLI supplies and this adapter does not.

So the page advertised, with the keyless posture its own placeholder describes, a provider that has no keyless posture — and the failure named the configuration key rather than the missing capability. The one thing that does authenticate the route is a ChatGPT OAuth token pasted into the key field, which is not what the offer describes and expires with nothing here to refresh it.

## Decision

The directory offers only what this adapter can authenticate. `catalogProviderTakesApiKey(provider)` answers whether pi-ai's installed provider for a route declares an api-key method — the one method the harness can feed, since it resolves a key through its own credential seam and hands it over as the request's `apiKey` override — and `directoryEntries()` skips the catalog routes that fail it.

OAuth support is not attempted. It needs a persistent credential store, a login flow, and a surface to run it from; none of those is a release-blocking fix, and shipping the offer without them is what produced the report.

Two boundaries keep the withholding narrow:

- **Catalog membership is unchanged.** `catalogProviderIds()` still answers what pi-ai ships, so the `declared` flag on a directory entry keeps meaning "no installed provider answers for this route" rather than "this route is not offered".
- **The profile half of the union is unconditional.** A route a settings document already names keeps its entry, so a stored `openai-codex` profile stays visible, editable, and deletable instead of being stranded in the document with nothing on the page to remove it.

Resolution is untouched. A profile naming `apiKeyEnv` on an OAuth-only route still builds a working provider — `routeAuth` adds the harness api-key method beside the catalog's OAuth, and pi-ai's Codex API derives the account id from the token itself — so a deployment that writes one into `settings.yaml` or `cordis.yml` keeps that path. Enforcing the withholding in `resolveProfiles` instead would have refused such a profile at registration, and because `validate` runs at boot as well as at write time, a document already naming a keyless OAuth route would fail the whole namespace's registration rather than one provider.

## Alternatives considered

- **Rejecting a keyless OAuth-only route in `resolveProfiles`.** This is where the repo normally enforces a decision, and the directory filter is a surface that a `cordis.yml` entry bypasses. It was refused for the boot behavior above: an existing stored profile would take down every other route in the namespace with it, which for a release trades a one-provider defect for a total one. The gap is that the offer, not the capability, is what got fixed — a deployment can still hand-write the route it can no longer add from the page.
- **Keeping the offer and correcting only the placeholder text.** The field would then have to say the provider needs a login this build cannot run, which is a card whose only honest content is that it does not work.
- **Mapping `Provider is not configured` to a named `LlmError`.** Worth doing, and reachable for reasons this change does not remove — any api-key route left blank whose provider finds nothing in the process environment produces the same message. Deferred as a separate change: it improves a diagnostic rather than removing a broken offer.
- **Reading `~/.codex/auth.json` into a pi-ai `CredentialStore`.** It makes Codex work without a login flow, and pi-ai owns the refresh. It also binds the harness to another tool's private file format for one provider, which is a decision for the OAuth work rather than a release fix.

## Consequences

`openai-codex` disappears from the provider picker and from the directory the Models page joins; every other installed provider is unaffected, including the six that offer OAuth *beside* an api-key method (`anthropic`, `github-copilot`, `kimi-coding`, `openrouter`, `radius`, `xai`), which keep their entries and their key path. A future provider that ships OAuth alone is withheld automatically rather than by name.

Two adjacent gaps remain and are recorded in the package README: a route naming no credential still resolves through the catalog provider's own discovery, which reads process environment variables only — not `~/.aws/credentials`, and not the harness credential seam — and the resulting failure is still the catch-all `PI_AI_ERROR`.

The withholding has since been retired: [credential records and authorization flows](../architecture/2026-08-13-credential-records-and-authorization-flows.md) gave the adapter a durable credential store and a login flow, so `openai-codex` is offered again and `catalogProviderTakesApiKey` is gone. The two boundaries below are what kept that reversal to one predicate and one directory filter.

## Testing

Package tests pin both halves of the union: the withheld route is absent from `listConfigurableProviders()` while `anthropic` and `openai` stay, and a stored `openai-codex` profile still produces a full entry with `declared: false`. The existing resolution tests are unchanged and still pass, which is what shows the withholding did not narrow what a hand-written profile can serve. The `models-settings` and `onboarding-usable-provider` web e2e goldens lost exactly the `openai-codex` option line, recorded against the real assembled application.
