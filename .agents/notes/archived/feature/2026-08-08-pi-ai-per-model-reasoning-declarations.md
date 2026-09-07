# Agent Note: Per-Model Reasoning Declarations in llm-pi-ai

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-08-pi-ai-per-model-reasoning-declarations.zh.md)

## Problem

Under the declared-provider catalog ([[2026-08-03-pi-ai-declared-provider-catalog]], which deliberately kept reasoning out of the configurable fields), a hand-declared pi-ai route's models materialized with `reasoning: false`, so `getSupportedThinkingLevels` short-circuited to `["off"]`: the composer offered no effort picker for them, and the route-level `reasoning` default — the only reasoning knob a profile had — made every request to such a model fail with `UNSUPPORTED_REASONING_EFFORT` before network I/O. The same route-level knob was also the wrong altitude for catalog routes: one provider's models disagree about which levels they accept (deepseek ships `[off, high, max]` beside catalog models with `xhigh`), so a single per-route level could not be set without breaking part of the route, which is why the Models page stopped writing it entirely (#1860) and left `settings.yaml` with no way to align efforts per model.

Two adjacent gaps compounded this. pi-ai decides the reasoning *wire dialect* (`compat.thinkingFormat`, `compat.supportsReasoningEffort`) by recognizing the endpoint URL, and a private gateway's URL says nothing — a DeepSeek-dialect gateway was spoken to in the OpenAI dialect with no configuration that could correct it. And the only way to touch one catalog model was the `models` list, which *replaces* the served catalog: narrowing `gpt-5`'s levels meant restating all thirty-eight openai models or silently dropping thirty-seven.

## Decision

`PiAiModelProfile` gains `reasoningEfforts`: **each key is a level selectors offer, its value the spelling dispatch sends on the wire**. The declaration translates to pi-ai's `Model.reasoning` + `thinkingLevelMap` with all seven levels decided explicitly — declared levels carry their wire value, undeclared levels are pinned `null` — so the profile author never needs pi-ai's asymmetric defaulting rule (absent means "supported" for the five base levels but "unsupported" for `xhigh`/`max`). `off` is the one three-state key: left out, no Off is offered and an explicit Off request is refused (an effortless request still goes out bare, leaving the provider its default); declared valueless, Off is offered and dispatch sends nothing (the `deepseek` dialect sends `thinking: {type: "disabled"}`); declared with a value, that value goes on the wire. `false` declares a non-reasoning model; an empty declaration is refused rather than guessed at. The spelling for "disable" is `false` rather than `{}` because schemastery materializes an absent dict as `{}` — only a `z.union([z.const(false), dict])` keeps absent, disabled, and declared distinguishable, and a bare `reasoningEfforts:` (YAML null) slips through that union unvalidated, so resolution refuses it explicitly.

`compat.thinkingFormat` and `compat.supportsReasoningEffort` become configurable at two levels — route (its models' default) and model (winning per field) — resolving model → route → installed catalog entry → pi-ai's URL guess. `thinkingFormat` is pinned to pi-ai's union through a `Record<UpstreamUnion, true>` drift gate, so a pi-ai upgrade that adds a format fails compilation until the new member is classified (verified against the published 0.84.1 tarball, whose `thinkingFormat` union adds `baseten` over the pinned 0.82.1). Which fields `compat` carries, which protocols take each of them, and how an unreadable key is refused are owned by [[2026-08-18-pi-ai-wire-compat-surface]]; the two-level resolution order above is what that surface generalizes.

`modelOverrides` reshapes individual catalog models without replacing the served set: key = catalog model id, value = a `models` entry minus `id`, materialized by handing the override to the existing entry path so capacities, efforts, compat, and request-default semantics stay identical. Unlike Pi's own config layer, which ignores unknown ids, every override that lands nowhere is refused — beside a `models` list, on a hand-declared route, naming an unknown model, or smuggling an `id` in the value (the schema passes unknown keys through, and a smuggled id would quietly rename the model).

## Alternatives considered

- **Pass `reasoning` + `thinkingLevelMap` through verbatim** (pi-ai's own radius-config shape). Rejected by the user for operator confusion: the map's `null`-marks-unsupported convention plus the asymmetric absent-key rule mean the config's meaning depends on knowledge of pi-ai internals; the chosen shape makes the key set itself the offer.
- **A bare level list** (`reasoningEfforts: [off, high]`). Cannot express wire renames, and the catalog's own maps prove renames are real: 66 of 1230 installed map entries are non-identity (`off→none`, `minimal→low`, `low→LOW`, `high→default`).
- **`{}` as the disable spelling.** Unimplementable: schemastery materializes an absent dict as `{}`, so every model without the field would have been force-disabled.
- **Folding this into the route-level `reasoning` knob.** That knob is a *default selection*, not a capability set; it stays, and a declared model's efforts now bound what it can select.

## Consequences

- The composer's effort pane works for hand-declared models with zero UI change — `resolveModelInfo` reports declared levels through the same seam catalog metadata uses (pinned by the `declared-reasoning` web scenario).
- #1860's deferred gap — a route-level effort a model cannot take failing its requests — now has an operator remedy: align the model's `reasoningEfforts` or drop the route default.
- There is deliberately no spelling for returning one map key or compat field to "whatever the catalog said": the declaration is the whole offer, so keeping a catalog value means restating it. The README documents this.
- `verify-package-invariants` is untouched: the feature adds configuration resolution, no new events or mutable runtime relations.
