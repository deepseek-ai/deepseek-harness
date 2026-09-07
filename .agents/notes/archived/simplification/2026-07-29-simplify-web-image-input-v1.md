# Agent Note: Simplify Web image input version one

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-29-simplify-web-image-input-v1.zh.md)

## Problem

The first durable Web image-input slice introduced required ordered multi-image intake alongside speculative surfaces for arbitrary CLI provider mounting, output-modality discovery, alternative text, provider-neutral visual token pricing, and browser lifecycle APIs with no cross-package consumer. Keeping the speculative surfaces would turn unchosen future behavior into public contracts and make the initial capability harder to review and maintain.

## Decision

Version one accepts ordered image batches bounded by configurable per-message count and aggregate-byte limits plus per-image byte and pixel limits. The browser rejects unsupported declared formats before preview allocation, while the host authoritatively decodes the complete batch, checks current deployment bounds, validates every image without storage writes, and only then saves every image while preserving submitted order in the resulting durable blocks. Request buffering derives directly from the attachment service's aggregate image-byte limit. This preserves validation atomicity without adding a batch transaction, rollback protocol, or policy snapshot in `host.describe`.

Provider/model selection remains configuration and profile state. The boot composition registers the shipped DeepSeek, OpenAI, and Anthropic routes; the CLI does not add image-specific selection flags, inspect the yml provider roster, or dynamically mount an adapter.

Exact-model metadata carries only the input modalities that current admission decisions consume. `ImageBlock` carries the durable attachment reference; its optional display name supplies accessible UI text, so the core block has no separate alternative-text field. Provider-neutral token estimation does not apply one provider's visual pricing formula to other routes.

The attachment seam exposes its limits plus storage-free `validateImage`, `saveImage`, and `readImage`. The host depends on that seam rather than implementation re-exports. Browser draft and historical-image operations remain concrete conversation-plugin internals; the public `IConversation` face contains only the input registry and the scoped send, cancel, and history verbs used across package boundaries.

## Alternatives considered

**Accept only one image.** Comparing or combining several images is a current product requirement. Count and aggregate-byte bounds keep that path finite without reducing it to a single image.

**Add a storage transaction or rollback protocol.** Storage-free validation prevents malformed later members from leaving earlier valid members unreferenced. Stronger all-or-nothing storage across independent content-addressed objects would require ownership or reclamation semantics that the current product path does not need.

**Keep future-facing fields and methods as placeholders.** Output modalities, block alternative text, and active-model handshake data had no current decision consumer. Adding them later with their first consumer preserves freedom to choose the correct contract.

**Estimate every image with one tile formula.** Visual pricing varies by provider, model, detail mode, and preprocessing. A hard-coded provider-neutral estimate would look authoritative while being wrong; provider usage is the authoritative accounting source.

**Add CLI provider/model selection or dynamic mounting.** Configuration already owns route selection, plugin composition, and credentials. Duplicating those choices in image-input flags would require parsing or mutating the config tree outside the loader.

## Consequences

The feature retains the two batch limits and one storage-free validation method required by multi-image prompts, while removing unrelated public fields, lifecycle operations, policy snapshots, and route-assembly branches. Provider/model selection remains composition or profile configuration. Pre-request token pressure keeps the structural heuristic only on routes without declared image pricing; the [route-priced estimator](../feature/2026-08-24-route-priced-image-request-pressure.md) supplies the provider-aware figure, and reported usage remains exact.

Reintroducing any removed surface requires a concrete consumer and its failure, lifecycle, replay, and testing contract rather than compatibility with this pre-release shape.
