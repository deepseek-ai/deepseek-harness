# Agent Note: Application consent for native Computer Use

Status: implemented

English | [中文](2026-09-26-cua-application-consent.zh.md)

## Problem

macOS privileges authorize an execution host, not a user's choice of target application. Retained app and window objects can outlive that choice. Concurrent permission decisions must not restore access after the user revokes it.

## Decision

The CUA executor owns application consent for every object-API and native-tool dispatch. It uses the existing User Questions service for human decisions and the provider's existing profile configuration for saved grants. General tool approval and operating-system privileges remain separate requirements. Arbitrary persistent PTC code and separately authorized shell tools retain their own execution authority.

A saved identity combines the canonical executable path with a verified designated signing requirement, represented by a SHA-256 digest. The path prevents authorization from following a copied application, and the signing requirement distinguishes replacements while allowing matching signed updates. Unverifiable and ad-hoc applications receive task access only, tied to a process instance and Agent connection lifetime. Labels do not establish identity.

Cold application selection prepares an executable identity and handle without launching. The same consent decision guards the private launch continuation, and the helper checks the executable again before launch and binds the resulting process afterward. Signed selections retain the normal designated-requirement identity; an unverifiable executable uses a content identity for this pending selection and cannot create a saved grant. Preparing metadata before asking avoids starting an application the user refuses.

Selections of the same application within one task are serialized, so a pending question does not produce competing decisions. Saved-grant additions read the current configuration inside one mutation queue. Refusals prevent another prompt within the task; an explicitly restored saved grant takes precedence at dispatch.

Removing a saved grant invalidates Agent connections retaining the application's handles and cancels active operations; Agent/provider disposal awaits native connection cleanup. Reauthorization uses a fresh connection, so old app and window snapshots cannot become valid again. The [native object decision](2026-09-17-experimental-cua-object-api.md) continues to own process identity, coordinate semantics, and separation from the evaluator.

## Alternatives considered

**Trust model instructions or hide controls.** Retained objects and direct tool calls can still reach native operations. The executor must enforce the decision at dispatch.

**Persist application names or unsigned paths.** A replacement can reuse both. Durable grants require a verifiable signing identity; task-only access supports unsigned development applications without that promise.

**Add an approval database or Session control stream.** Profile settings already own user configuration, and User Questions already owns interactive answers.

**Keep the native context after revocation.** Its application lookup can return an earlier handle and retain window snapshots. Closing the Agent connection discards its native context through existing transport cleanup; preserving unrelated handles would require a native per-application retirement protocol.

## Consequences

Revoking one application also invalidates other application handles on the same Agent connection. Those applications require fresh selection; saved grants remain reusable, while task grants expire. Other tasks with independent connections remain unaffected unless they also hold access to the revoked application.


Application decisions and failure results are exercised through policy regressions and the recorded CUA scenario. Desktop binary distribution, signing, and packaged-host permissions remain outside the source-launch workflow.
