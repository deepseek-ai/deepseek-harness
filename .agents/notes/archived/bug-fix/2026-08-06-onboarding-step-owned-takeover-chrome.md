# Agent Note: onboarding takeover chrome moves into the step

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-onboarding-step-owned-takeover-chrome.zh.md)

## Problem

The settings shell mounted the onboarding takeover chrome — a body-portaled overlay with an opaque `--dsw-alias-bg-layer-1` stage, a blur mask, and `#root` set inert — the moment a `settings.onboarding` step was registered and not yet locally completed. Every step decides whether it actually needs to show by loading a private fact first (WelcomeNotice: the acknowledgement bit through its settings join; DeepSeekOnboardingDialog: credential readiness through the Models join) and renders `null` while that fact is in flight. Rendering `null` could not suppress the chrome, because the opaque stage was painted by the shell around the slot outlet, not by the step.

On every reload while the hero (blank or no session) was current, the sessions list turning `ready` therefore popped a full-screen opaque layer — white in the light palette — and blocked all interaction for exactly one credential/settings RPC round-trip, after which the already-configured steps self-completed and the layer vanished. Users saw the app flash white each refresh the moment the workspace/session lists landed.

## Decision

The takeover chrome belongs to the step, not the shell. A new zero-cordis primitive, `OnboardingSurface` (ui-primitives), renders the body-portaled overlay/mask/stage — CSS class names and geometry moved verbatim from `SettingsRoot.module.css` — and holds `#root` inert for exactly its own mount lifetime. Both step components wrap only their **visible** branch in it; their existing `null` branches now paint and block nothing by construction, because the chrome is part of the same render decision.

`SettingsRoot` keeps the coordinator exactly as it was (ordered ledger projection, one mounted step, local completed set, `stepId`/`complete`/`openSection` currency) but renders the elected step bare — no portal, no stage, no inert effect. The `settings.onboarding` slot contract now states that registrants own the surface wrap and must render `null` while their private facts are undecided.

## Alternatives considered

**Register steps conditionally (ledger as the has-content signal).** Register the entry only after the private join resolves to "needs intervention". Architecturally clean (publish at the commit point) but a larger change: the join load must move from the dialogs into each plugin's apply, and registration/disposal becomes reactive plumbing in two packages. Rejected as oversized for the defect.

**Convert `settings.onboarding` to a chain with an externalized completed-set store.** The composer-takeover pattern; prototyped and reverted. Selectors can only judge owner props, so the private readiness facts still had to be resolved inside the components — the chain bought routing generality the two current steps do not need, at the cost of a contract change across three packages.

**Detect empty slot output at the render site.** `renderSlot` returns an outlet element unconditionally, so the owner cannot branch on a step's `null`; probing rendered DOM emptiness needs a commit-then-retract dance whose dynamic transitions lose the pre-paint guarantee.

## Consequences

While a step is mounted but undecided, the application stays visible and interactive: `#root` is no longer inert during the decision window (previously it was inert behind an opaque layer). For a genuinely unconfigured user the takeover now appears one join round-trip later than before — but with its content already present, instead of an empty stage that fills in.

A future step that registers without wrapping its visible content in `OnboardingSurface` renders bare over the app with no mask; the slot contract JSDoc names the wrap as the registrant's obligation.

## Testing

`packages/client/ui-primitives/tests/onboarding-surface.client.spec.tsx` pins the primitive: body portal around the content, mask/stage class presence, `#root` inert held for exactly the mount lifetime, and the no-`#root` composition. `packages/client/ui-settings-general/tests/settings-root.client.spec.tsx` pins the inverted shell contract: no takeover chrome and no inert while a mounted step renders nothing. `apps/web/tests/onboarding-deepseek-config.e2e.ts` gains the defect's assembled regression pin: a configured world reloads while every `settings.describe` response is held open at the browser's network boundary — widening the steps' deciding window from loopback-invisible to hundreds of milliseconds, which is what keeps the assertions non-vacuous — and an 8 ms in-page sampler proves the takeover chrome never mounts and `#root` never turns inert. The file's existing scenarios and the step specs (`ui-settings-general`, `ui-settings-models`) pass unchanged — the mask selector and geometry pins survive because the stylesheet moved verbatim.
