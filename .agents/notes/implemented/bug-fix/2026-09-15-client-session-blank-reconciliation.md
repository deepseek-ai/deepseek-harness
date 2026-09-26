# Agent Note: Keep accepted Session presentation across list refreshes

Status: implemented

English | [中文](2026-09-15-client-session-blank-reconciliation.zh.md)

## Problem

A successful prompt response converts the Client's `New Session` row before a turn necessarily starts. A later `session.list` response can still report `blank: true` and undo that conversion. Reconnect triggers the same refresh. Keeping the conversion only inside a Session object also loses it when that object is replaced.

## Decision

The [Manager](../../../../packages/api/session-controller/src/client/sessions/manager.ts) retains accepted/running observations in a private set keyed by Session id. List rows and the existing Session blank updates use `summary.blank && !engagedSessions.has(sessionId)`, with `sessionListMetadata` hints still applied on top. The existing summary mutations, Session snapshot fields, constructor, and projection stores retain their responsibilities.

Every successful prompt response invokes the existing `onEngaged` callback, including from a replaced Session object. The Manager updates its retained observation, the list row, and the currently resident Session by id. Rejection records no engagement. A `running: true` status, addition, or list baseline also records engagement; a baseline predating removal cannot restore that observation, even if the row is re-added during the pull.

The observation survives refresh, reconnect, and object replacement. Removal, drop, and successful list refresh forget it only when no list row, Session object, or child address retains the identity. Refresh evaluates retention after replaying in-flight mutations; failed and superseded pulls do not prune observations. Late acceptance cannot recreate a removed row or a Session object. Manager disposal clears the set and prevents late acceptance and outstanding list responses from publishing.

Engagement is display memory, not proof that a turn started, work remains queued, or a message reached durable storage. It is not persisted across page reload. Historical `sessionListMetadata.blank` and the Host summary defaults are unchanged.

## Alternatives considered

**Preserve every previously false summary bit.** A previous Host summary is not evidence of local acceptance or running. Making all false values permanent would also suppress later Host corrections without either observation.

**Introduce a shared Session record.** Combining this memory with projection stores requires constructor and cache-lifetime changes. Those changes are independent of preventing a blank rollback and are excluded.

**Wait for history before converting the row.** This changes the existing acceptance-time display rule and is a separate UI decision.

## Consequences

Accepted or observed-running Sessions retain their existing display conversion, including when accepted input never starts a turn. Drafts, submission-error recovery, sidebar filtering and title rules, creation/reuse, UUIDs, Host protocol, persistence, and projection-cache lifetimes are unchanged. Reverting this Client-only fix needs no data migration.

The Manager owns one additional per-id display flag. It does not replace Session-local presentation fields or implement a history/draft/presentation redesign.

For an identity with neither subagent origin nor a retained child address, a removal notification discards its projection store unless that store already carries a non-empty `subagentCatalog`; a retained Session object keeps the store it was constructed with — for example a current row removed while its Session is still staged. If its projection store was discarded and that identity returns to the list before its Session object is dropped, the Manager creates and seeds a second store that the resident object never reads, so list rows and that object's projection readers can disagree until a replacement instance adopts the current store. Repairing that projection ownership is deferred to its own change; blank display does not depend on it.

## Verification

Manager tests cover refresh without a turn, running-to-idle updates, object replacement, late acceptance, removal through notifications or list reconciliation, retained instances and child addresses, failed and superseded pulls, and disposal. They check both list and Session state where an instance exists. Session tests retain first-send rejection and later-send behavior. Browser verification uses the recorded first-turn scenario with acceptance held before `turn/start` and a same-page reconnect. A timestamp substituted only in the reconnect list response provides a visible synchronization marker; the Host's blank/running values and durable log remain unchanged.

## Related decisions

The [scope and provisioning decision](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md) owns Session scope, creation/reuse, and the visible blank row. The [Session/Conversation ownership decision](../architecture/2026-08-20-client-session-conversation-ownership.md) owns transport, assembly, and snapshot contents.
