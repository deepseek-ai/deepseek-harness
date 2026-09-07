# Agent Note: official DeepSeek first-run credential setup

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-deepseek-onboarding-credential-setup.zh.md)

## Problem

The [web configuration plane](../architecture/2026-07-30-web-config-plane.md) makes provider settings and credentials live-editable, but a first-time user still lands on the empty conversation Hero without an actionable explanation when the shipped `deepseek-official` route has no credential. The Models page can repair that state, yet requiring the user to discover it weakens onboarding. A prompt must not confuse a missing credential with a missing adapter: the browser can store a value for an existing credential reference, but it cannot dynamically mount the `llm-deepseek` Cordis plugin.

## Decision

**One readiness projection owns both Models and onboarding facts.** `ui-settings-models` keeps a single store that joins `llm/listProviders`, `llm/listConfigurableProviders`, the redacted namespace views held by the shared settings describe mirror, and batched `credentials/describe`. The onboarding projection selects the `deepseek-official` configurable-provider entry owned by the `llm-deepseek` namespace and empty settings path, reads the effective `apiKeyEnv`, and evaluates the matching credential descriptor. A live route with the same provider id but no matching configurable-provider declaration is adapter-absent for onboarding. A configured process-environment credential is ready and remains read-only. The later [settings describe mirror decision](../architecture/2026-08-17-settings-describe-mirror.md) owns that settings read and its invalidation ordering.

**The settings shell contributes ordering, not provider policy.** `ui-settings` declares a root-scoped `settings.onboarding` list slot and mounts one ordered step at a time while the current surface is the empty Hero. The active registrant receives `complete()` and a private `openSection(id)` callback; completion transfers ownership to the next entry. `ui-settings-models` registers the DeepSeek step, the preceding welcome notice, and its Models section through `slots.inject()`, so every contribution follows one client Cordis plugin's lifecycle and the dialogs cannot stack. Their common presentation is owned by the [shared-modal onboarding decision](2026-08-13-shared-modal-product-onboarding.md).

**The prompt renders the existing credential editor inline.** A mounted, active adapter with a resolved, writable, unconfigured reference renders `ProviderEditor` in credential-only mode inside the shared onboarding modal. The same component owns the password input, validation, `credentials.set({ref, value})`, write failures, and post-write refresh; credential-only mode emits no provider-settings mutation. Configure later completes only this coordinator pass. An absent adapter remains skipped because the browser cannot mount a missing Cordis plugin.

**Unavailable states do not capture the product.** An absent configurable-provider entry, inactive route, failed initial join, read-only deployment, or unresolved settings or credential capability completes the step without rendering because the onboarding action cannot repair that state. The Models page remains the deployment diagnostic and retry surface. Configure later completes a missing-credential step for the current mounted coordinator pass and writes no completion fact. Settings, credential, provider-topology, and connection invalidations all refresh the shared join, so an external credential update completes an open step without a reload.

## Alternatives considered

**A separate onboarding store and readiness RPC sequence** — rejected because it would create a second client-side interpretation of provider identity, settings paths, secret sidecars, credential references, and invalidation ordering beside the Models page.

**A standalone API-key implementation inside onboarding** — rejected because it would duplicate the Models editor's secret draft, validation, errors, and configured-state convergence. The modal renders the existing `ProviderEditor` in a constrained mode instead.

**Writing the API key into provider settings** — rejected because a literal secret would enter the settings mutation path and whole-section replacement cannot safely reconstruct redacted values. Credential storage is already the product seam and supplies immediate invalidation.

**Showing the prompt when `llm-deepseek` is absent** — rejected because browser navigation has no supported operation that mounts the missing Cordis plugin.

## Consequences

The ordered flow leads from the product notice to an inline key form without restarting: a keyless browser test boots the real Web composition under an isolated harness home, acknowledges the notice, stores a generated key from the shared modal into the home's `.credentials.yaml`, verifies no key reaches DOM, ARIA, or browser console output, and confirms the ordinary Models page reports configured. The full keyless Web replay lane also pins that a non-configurable replay route with the same provider id does not block unrelated journeys. Pure readiness and React tests pin managed-file and process-environment credentials, missing providers and capabilities, cancellation, external invalidation, and coordinator transfer. The flow deliberately inherits the configuration plane's documented base limitations rather than adding local secret storage, redaction, or settings replacement workarounds.
