# Agent Note: Explicit model-facing tool order

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-06-explicit-tool-order.zh.md)

## Problem

Model-facing tool order followed plugin registration order, which depends on concurrent module loading for otherwise independent plugins. That race produced different request headers in CI and snapshot recordings. Because order affects request bytes, caching, and the durable header, it needs an explicit deterministic policy.

## Decision

The system-prompt assembly owns the canonical model-facing tool order, exactly where it already owns section order. `toolOrder?: string[]` on `dsh-system-prompt` is the optional explicit policy:

- A listed tool that is registered takes its listed position.
- A listed name with no registered tool is a configuration error. Shape errors (rest entry missing or duplicate names) fail from the service constructor; an unregistered name rejects every `assemble()` — the earliest moment the registered tool set exists to check against (tool plugins register after the service constructs), and the only universal one (registrations can change at any time; cordis has no "all plugins loaded" event). Under the shipped loop the first turn fails before any model request — see the consequences below for the exact blast radius.
- A registered tool absent from the list is inserted at the `'<unlisted-tools>'` rest entry (`TOOL_ORDER_REST`), in lexicographic name order among the other unlisted tools.
- No collected tool may use `TOOL_ORDER_REST` as its `ToolSchema.name`; the assembly rejects that reserved name before ordering.
- The list must contain the rest entry exactly once and no duplicate names.
- When `toolOrder` is unset, the canonical order is plain lexicographic name order (code-unit comparison, locale-independent), so determinism requires no configuration.

`assemble()` canonicalizes provider tools before the `system-prompt/assemble` waterfall, removing registration-order variance at its source. The waterfall starts from this deterministic list; unchanged order then flows into the request header, frozen request, and reconstruction checks without loop-specific ordering logic.

Scope is deliberately narrow: this fixes the REGISTRATION-ORDER race, not plugin behavior. A `system-prompt/assemble` listener may still add, remove, or rearrange tools — same as it may edit sections after their sort — and owns the determinism of what it emits; the waterfall contract already demands deterministic listeners (the reconstructability invariant would catch a listener that diverges between build and replay).

Config plumbing follows the `persona` precedent, and `toolOrder` sits beside it on each composition's `dsh-system-prompt` row. One schemastery footnote is load-bearing: a schemastery array defaults to `[]`, but an omitted `toolOrder` must stay ABSENT (= lexicographic) rather than become an explicitly configured empty list (invalid — it lacks the rest entry), so every schema that accepts the field forces the default to `undefined`.

## Alternatives considered

- **Registration order (the status quo)** — a concurrent-import race, host-dependent (the CI flake above), invisible in review.
- **A linearization of the plugin dependency graph** — the relation is partial and independent tool plugins are incomparable; the flake happened with the partial order fully satisfied.
- **Per-plugin `weight` on each tool contribution** — scatters the order across plugins yet still needs a global numbering convention nobody owns (the section `order` bands show that coordination cost being paid by hand).
- **Sorting in `ToolRuntime.schemas()` (the registry layer)** — equally deterministic, but the registry is a membership store consumed by more than the assembly; ordering is a prompt-composition concern, and the assembly already owns the composition policy for sections.
- **A `LlmRuntime` config + `orderTools()` method the loop calls before logging the header** — works, but adds a public service method and a loop edit solely to apply a policy at a distance; every future request composer must remember the call. Canonicalizing where the list is born makes an unordered list unrepresentable, with zero new API.
- **Normalizing inside `llm.stream()`** — runs after the header event is logged (the flake survives) and rebuilds the deep-frozen envelope, silently disarming the reconstruction invariant.
- **An exhaustive list (no rest entry)** — every newly loaded tool plugin would break boot; the mandatory rest entry keeps unlisted tools deterministic and their position explicit.
- **A boot-time validation pass (a `SystemPrompt.assertToolOrderSatisfied()` called by `dsh-app-boot` after `loader.await()`)** — would turn the misconfiguration into a startup death instead of a first-turn failure, but costs a public service method plus a structural coupling from the generic boot glue to one service, and cannot replace the assembly-time check anyway (embedded callers never run app boot; registrations change after boot). No existing event can host the check either: cordis v4 has no ready-like event, `loader/entry-init`/`internal/status` fire mid-load (racy against tool registration, the very entropy this Agent Note kills), and the agent lifecycle events are no earlier than the assembly. One enforcement point at `assemble()` was judged worth the later failure moment.

## Consequences

- Every registry-built assembly starts with a deterministic tool order on every host; absent an expert listener that deliberately changes it, every `request/header` event and model request inherits that order. The CI-vs-local registration-order flip is structurally gone, and the default is lexicographic.
- The initial `PromptAssembly.tools` is canonical, so waterfall listeners start from the model-facing order; provider registration order is observable nowhere before that cooperative extension point.
- The snapshot suite's single pinned request-header fixture (`text-turn`) carries the new canonical tool order; every other ACP snapshot keeps the header bulk scrubbed as `{{system}}`/`{{tools}}`, per the pinned-header design.
- A pure tool reordering between steps is logged like any other header change: a full `request/header` snapshot with reason `'change'`. Stable canonical order prevents registration timing from creating such changes in the ordinary path.
- The `toolOrder` key rides the app → `agent-core` → `SystemPrompt` forwarding chain, so deployments set it next to `persona` in the app config; `dsh-llm` and the agent loop are untouched.
- A misspelled or unloaded tool name in `toolOrder` fails the turn at prompt assembly, not the boot: the loop assembles inside the turn (after `turn/start`, before `step/start`), so the rejection reaches the turn's outer catch — the turn closes balanced with an `error` reason carrying the message, `agent/error` mirrors it, no step opens, no `request/header` is logged, no request reaches the adapter, and the agent returns to idle. Every turn fails identically until the config is fixed; the process itself stays up (matching the repo rule that explicit config references must not be silently ignored — the enforcement point is the assembly because no earlier universal moment exists).
- A tool provider that returns the reserved rest-entry name has the same prompt-assembly failure shape as an unknown listed name. This keeps the sentinel from becoming an ambiguous real tool and preserves the "never drops a tool" ordering contract.

## Testing

System-prompt tests cover lexicographic default order, listed/rest placement, provider-order independence, shared names, invalid lists, unknown or reserved names, the canonical pre-waterfall list, and the rule that listener-added tools are not re-sorted. Loop tests pin identical logged and dispatched order across registration permutations, forwarding through agent-core and both apps, deep-frozen requests, and balanced turn failure with no step, header, or adapter call for an unknown configured name. Snapshot replay keeps the full canonical list only in the pinned `text-turn` header; other fixtures continue to use `{{tools}}`.
