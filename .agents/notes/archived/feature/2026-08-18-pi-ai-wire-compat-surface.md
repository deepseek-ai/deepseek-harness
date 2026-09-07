# Agent Note: pi-ai Wire-Compatibility Surface in llm-pi-ai

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-18-pi-ai-wire-compat-surface.zh.md)

## Problem

pi-ai shapes every request from the provider id and the baseURL — which role carries the system prompt, which field caps output, whether `store` and `stream_options` go out, whether tool definitions carry `strict`. For an endpoint its detection does not recognize, the answer is "this is OpenAI itself": `detectCompat` returns `supportsDeveloperRole: true`, `maxTokensField: "max_completion_tokens"`, `supportsStore: true`. A hand-declared route is by construction an endpoint pi-ai does not ship, so every such route received OpenAI's own request shape.

The adapter offered two of pi-ai's thirty compat fields ([[2026-08-08-pi-ai-per-model-reasoning-declarations]] scoped them to "the switches pi-ai's reasoning dispatch reads"), and `supportsDeveloperRole` fell inside that scope while being absent from it: its send site is `model.reasoning && compat.supportsDeveloperRole`. A hand-declared model declaring `reasoningEfforts` therefore sent its system prompt as `role: "developer"`, which most OpenAI-compatible gateways reject, and no configuration could say otherwise — the gateway could not be connected at all.

Writing the field anyway was worse than unsupported. schemastery passes unknown keys through, and resolution read only two names, so `compat: {supportsDeveloperRole: false}` validated, persisted, and was then dropped: the operator saw an accepted write and an unchanged failure. `maxTokensField` carried the same defect over a wider blast radius, since it shapes every request rather than only a reasoning model's.

## Decision

One drift gate per pi-ai compat type — keyed `Record<keyof OpenAICompletionsCompat | …, CompatDisposition>` — classifies every upstream field as `offer` or `withhold`. Thirty-four distinct fields, twenty-three offered. The line is what a private URL can imply: a deployment must be able to state what nothing can infer from an unrecognized endpoint, while a field pi-ai's installed catalog sets for a named vendor stays withheld, because a route reaching for `openRouterRouting` or `deferredToolsMode` is a catalog route that should be named as such and inherit the value.

`PiAiCompatProfile` stays an explicit interface with per-field JSDoc — it is what a configuration surface renders and what `docs/config-catalog.md` pastes — and a type-level `AssertNever` over the symmetric difference proves it names exactly the offered set. The schemastery schema is declared `z<PiAiCompatProfile>`, and `exactOptionalPropertyTypes` is what makes that annotation load-bearing in both directions, so the four faces lock together: an upstream field added, a gate entry missing, an interface field forgotten, or a schema key omitted each fails compilation. Field *types* are derived from upstream rather than restated, and a second proof pins the profile assignable to the upstream compat types, so a widened value union cannot silently narrow what configuration accepts — the cast to `ModelCompat` at materialization would otherwise hide it.

Protocol applicability is per field, and grouping follows the compat *type* rather than the protocol name: pi-ai gives `openai-responses`, `azure-openai-responses`, and `openai-codex-responses` one `OpenAIResponsesCompat`, so a switch settable on one is settable on all three. Keying by protocol name alone refused two shipped catalog routes the fields their own models declare. The protocol set is derived from `Model.compat`'s own conditional, so a release that gives a further protocol a compat type fails the gate list by name. A model-level switch its protocol does not take fails resolution naming what that protocol does offer; a route-level one lands on the models that read it and skips the rest, and is refused only when no model on the route could read it. `chatTemplateKwargs` and `chatTemplateArgs` are offered, which makes the two `chat-template` formats and `baseten` nameable; nothing cross-checks those pairings, because the format in force may come from the catalog entry or from pi-ai's detection, neither of which resolution can read.

Three kinds of `compat` key are refused where they are written rather than dropped: one no protocol declares, one a gate withholds, and one written with no value. The check runs over every key before any protocol resolves, so a misspelling fails even on a route whose models never reach the protocol that would have taken it. It reads raw keys deliberately: a withheld or undeclared name is absent from the schema, so schemastery cannot have materialized it and a person wrote it. The valueless case is the one that has to fail rather than be ignored — schemastery passes a YAML bare key through as null, and carrying it forward writes null over the installed catalog's value, leaving pi-ai's `??` reaching for its baseURL detection with the catalog layer skipped entirely. Fields carrying a value are then filtered separately, because schemastery materializes absent dicts as `{}` and both template-argument fields are present on every parsed profile whether or not anyone wrote them.

## Where a refusal lands

Every check runs in `resolveProfiles`, which no request path re-enters: the adapter memoizes by raw-snapshot identity and `apply` resolves once eagerly. A refusal therefore reaches `settings.mutate` as `settings-rejected` before persistence, a `cordis.yml` `config:` block as a failed plugin mount, and a stored section as a failed `settings.register` at startup.

An external edit to the settings file is the one path that cannot report: the provider watcher calls `publish()`, which catches a failing section, logs `settings: keeping last good "%s"`, and leaves the namespace serving its previous value. That is the settings seam's behavior for every schema and validator failure, not something this surface introduces, and closing it belongs to that seam rather than here. What changes for compat is the failure model, not the reporting: a key that formerly stayed inert forever now stops the next start.

## Alternatives considered

**Add `supportsDeveloperRole` alone.** It fixes the reported gateway and leaves `maxTokensField` — which shapes every request, not only a reasoning model's — breaking a whole class of endpoints, with the next upstream addition free to lag silently again.

**Offer every upstream field.** pi-ai's own custom-provider documentation converges on a far smaller set, its flagship example naming six, and the remainder are vendor-bound switches its catalog already sets. Exposing `zaiToolStream` or `vercelGatewayRouting` on a hand-declared route offers a knob whose correct use is to not be a hand-declared route.

**Key `compat` by protocol** (`compat: {openai-completions: {…}}`). A hand-declared route has exactly one `api`, so the nesting states what the route already said, and it breaks every profile written against the flat shape for nothing.

**Accept an opaque passthrough dict.** The schema is also the shape a configuration surface renders and the declaration `verify-config-catalog` cross-checks, both of which an unstructured dict defeats; it would also let a responses-only field land on a completions model, which per-field applicability exists to refuse.

**Warn instead of refusing an unknown key.** That is the posture that hid this defect for the life of the surface: an accepted write and an unchanged failure teaches the operator that the switch does not work, not that the name is wrong.

**Suggest a near spelling on an unknown key.** No repository utility computes edit distance, and adding a dependency or hand-rolling one under the per-file coverage gate is disproportionate for a diagnostic. Naming the offered fields answers the same question deterministically: the vocabulary check runs before any protocol resolves, so it names the whole offered set, while the per-protocol refusal narrows to what that protocol takes.

## Consequences

- An OpenAI-compatible gateway that rejects the `developer` role, `max_completion_tokens`, `store`, `stream_options`, or `strict` is now configuration rather than an unreachable provider, and the same holds for an Anthropic-compatible gateway rejecting `temperature` or tool `cache_control`.
- A pi-ai upgrade that adds a compat field or thinking format fails the build until someone classifies it; the gates include both template-argument fields and every current format.
- Unknown compat keys join every other configuration error's failure model. The improvement over the previous silent drop is bounded by the settings seam: an external file edit still keeps its last good value and warns, so the operator's signal is a restart rather than the write.
- **Deferred, not closed:** a route that repoints `api` and configures no compat at all keeps the installed entry's `compat` through the model literal's `...base` spread, in the *other* protocol's shape. Fields several compat types share (`supportsLongCacheRetention`, `sendSessionAffinityHeaders`) therefore cross protocols. It predates this surface — the early return it rides existed before — and is left for its own change.
- **Deferred, not closed:** `publish()` reports a rejected stored section only through `ctx.logger.warn`, with no user-visible channel. It affects every settings namespace and is owned by `dsh-settings`.
- [[2026-08-08-pi-ai-per-model-reasoning-declarations]] is partially superseded: its compat-scope statements are restated here, while its `reasoningEfforts` shape, the alternatives that shape beat, and `modelOverrides` remain the current authority.
