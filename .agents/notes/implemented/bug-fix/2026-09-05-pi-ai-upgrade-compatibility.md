# Agent Note: pi-ai upgrade compatibility

Status: implemented

English | [中文](2026-09-05-pi-ai-upgrade-compatibility.zh.md)

## Problem

The pi-ai adapter classifies upstream compatibility fields explicitly and persists only replay metadata needed by later requests. An SDK upgrade can add fields to either set without changing the Harness provider-neutral API. Unclassified configuration fields fail compilation; omitted replay metadata can silently change subsequent provider requests.

## Decision

The adapter follows [pi-ai 0.85.1](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/CHANGELOG.md). `thinkingTokenBudgetField`, `vllmPriority`, and `supportsMaxOutputTokens` are opt-in gateway controls; `thinking.budget` joins the existing template placeholders. The SDK owns budget resolution and serialization. `supportsMidConvoEffort` and `allowedFallbackModels` remain catalog-owned because their correctness depends on exact Anthropic transports, model capabilities, and fallback pricing.

Optional `providerThinkingLevel` remains in the adapter replay-v2 response metadata so Anthropic history retains its provider-native effort. Absence remains valid; neither the replay version nor the released Session format changes. Replay provenance retains the requested model while `responseModel` retains an Anthropic alias resolution or fallback. Reconstruction restores that native model so pi-ai still applies its cross-model signature rules. The provider-neutral LLM API stays unchanged; the [provider-routed replay ownership rules](../architecture/2026-07-14-provider-routed-llm-adapters.md) still apply. The 0.84.2 Anthropic adapter [initializes `model` from the request](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/anthropic-messages.ts#L510-L515) and [records only response id and usage at message start](https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/anthropic-messages.ts#L589-L605). It never writes `responseModel`, so its replay records retain the requested model without native-model metadata.

## Alternatives considered

**Withhold every new field.** This would misclassify deployment-owned gateway controls as catalog facts: upstream explicitly leaves budget-field selection and vLLM priority out of its generated catalog.

**Expose every new field.** This would let arbitrary gateways claim model-specific Anthropic effort and fallback support without the catalog evidence that makes those features valid.

## Consequences

Compile-time coverage retains explicit field classification. [Compatibility tests](../../../../packages/llm/llm-pi-ai/tests/compat-upgrade.spec.ts) cover schema acceptance, invalid values, protocol applicability, and materialization without changing defaults. [Replay conversion tests](../../../../packages/llm/llm-pi-ai/tests/convert.spec.ts) cover optional effort preservation. Mixed-protocol catalog tests use the installed OpenCode catalog. Provider behavior remains upstream-owned; live provider verification is separate from keyless adapter tests.
