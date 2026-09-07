# Agent Note: Recoverable provider credential lifecycle

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-provider-credential-lifecycle.zh.md)

## Problem

The Models editor spans independent settings and credential RPC domains. It previously committed provider settings before storing the API key but kept the revision and original subtree from when the card opened. If the credential write failed, retry replayed the already-committed settings mutation with a stale revision and produced a conflict, leaving the user unable to complete the second stage from the same card. A blank pi-ai key also wrote the derived `apiKeyEnv` without a credential, which prevented pi-ai from using provider-native discovery. At deletion, the inverse leak remained: the profile disappeared but its page-stored key stayed in `.env` and silently became active when the provider was added again. Generic row actions and confirmation copy did not identify which provider would be changed.

## Decision

Provider save remains a two-stage settings-then-credentials operation over the existing wire domains, but the card treats the successful settings response as a commit checkpoint. It replaces its comparison subtree and expected revision with the returned redacted descriptor before attempting `credentials.set`; if that second stage fails, the draft key and card stay visible, and retry produces no settings ops and repeats only the credential write. Genuine concurrent changes before the first settings commit still fail with `settings-conflict`. Typed keys are trimmed at the UI and direct DeepSeek resolver boundaries, and pi-ai records a derived reference only when the normalized key is non-empty; saving a blank key materializes an empty, reference-free profile for provider-native discovery.

Deletion removes a credential only when the joined row identifies the exact `<ROUTE>_API_KEY` reference derived by this page and reports it configured and writable. It unsets that credential before the user-layer profile so a settings-stage failure leaves the row and its frozen target visible for retry; both unsets are idempotent. Custom references, environment credentials, missing credentials, and targets the join cannot identify are retained. The row's accessible Edit/Delete names and the destructive dialog title, description, and final action all use the same stable `Display Name (route-id)` identity, collapsing to the route id when both strings match. The dialog states whether the stored key will be removed and owns operation failures instead of replacing the whole page with a load-error banner. Rows expose API-key state only from the value-free join: a confirmed referenced credential is a green solid dot, a confirmed missing named reference is a red solid dot, and reference-free provider-native authentication or unavailable credential enrichment has no dot. Each dot has accessible copy and a tooltip, while successful Apply uses the same provider identity in a local status message and never echoes secret material.

## Alternatives considered

**Add a cross-domain transaction RPC.** Settings and credentials have separate owning services and durable stores; introducing a new host transaction would broaden the public wire and still require compensation for provider-specific persistence failures. The UI checkpoint makes the current ordered stages recoverable without adding a fourth configuration contract.

**Delete every credential reference named by a removed profile.** A custom reference can be shared, externally managed, or intentionally survive profile churn. Exact equality with this page's derived target plus configured+writable state is the narrow evidence available to the page; anything weaker risks deleting a credential it does not own.

**Remove settings first and compensate by recreating the profile.** The browser holds only a redacted subtree and cannot faithfully reconstruct concurrent edits. Credential-first deletion leaves the authoritative profile visible on partial failure and makes retry safe without synthesizing configuration.

## Consequences

The Models page can recover from either second-stage failure without reload, secret disclosure, or a false concurrency conflict, and blank-key pi-ai profiles preserve Bedrock, Vertex, and other provider-native authentication. Confirmed status is visible without turning route liveness, native authentication, or a failed credential lookup into a false error, and a successful replacement remains observable even when the row stays green. Deleting a page-managed provider no longer leaves a reusable local key, while ambiguous credentials deliberately remain for manual management. Save and delete are still not atomic across durable stores: a process crash can stop between stages, but their order and idempotence leave an observable, retryable state. Component tests pin partial-success retries, empty-key native auth, trimmed key handling, status visibility, target identity, cleanup ownership, and credential/settings rejection ordering; the keyless browser scenario pins bilingual accessible copy and verifies that confirmed deletion removes both the `settings.yaml` profile and `.credentials.yaml` entry. This decision refines the Models apply semantics recorded in the [web configuration plane note](../architecture/2026-07-30-web-config-plane.md).
