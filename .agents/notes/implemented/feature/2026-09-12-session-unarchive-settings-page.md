# Agent Note: Session unarchive Settings page

Status: implemented

English | [中文](2026-09-12-session-unarchive-settings-page.zh.md)

## Problem

Archiving a Session removed it from every Workspace grouping surface, and nothing brought it back. The archive set is a durable display filter, so a hidden Session kept its log, its Workspace accounting slot, and its position, but the only recovered route was editing the domain state by hand. The archived feature record predicted the restore surface as "one UI surface plus one inverse RPC"; both now exist, and the Client had no place that listed archived Sessions at all.

## Decision

`WorkspaceRegistry.unarchiveSession(sessionId)` drops one id from the registry-global `archivedSessionIds` set in a single durable `setState`, running on the same operation chain as archive, create, and delete. The idempotent check-then-write pair sits inside one chain slot, so a concurrent archive cannot interleave and a lost race resolves as a no-op. An id that is not archived resolves without writing.

Unarchiving runs no session-existence probe. Archive verifies that the Session is live or persisted because it adds a reference that must resolve; unarchive only removes an id, so it cannot introduce an unknown referent and an entry whose Session is gone still restores. `@Remote('unarchiveSession')` on `WorkspaceController` returns the complete `WorkspaceArchiveValue`, matching `archiveSession`, and `IWorkspaces.unarchiveSession` plus `UiWorkspace.unarchiveSession` carry the verb to the browser. Both verbs answer with the complete set, so `ClientWorkspaceModel` installs a reply only while it is still the latest archive-set request: a later request, or a set pushed by the follow stream, supersedes an in-flight answer and keeps the projection on the newer state.

The new Web Settings page `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions` owns the surface. It registers one localized `settings.section` contribution with id `archived-sessions` at nav order 25, joins the archive set from `useWorkspaces` with the loaded Session summaries from `useSessions`, lists the newest archive first with the owning Workspace title or the ungrouped label and a relative last-activity time, filters by title or Workspace name, and offers one Unarchive action per row. A rejected write is logged as a console diagnostic and leaves the row for another attempt. An archive entry whose Session summary is missing produces no row, so the page never renders an action that cannot restore anything.

Restoring is a page whose subject is archived Sessions, and the archived Sessions themselves are hidden from every grouping surface, so no Session row can host the action. The archived-sessions page joins the Settings navigation beside General, Models, and Plugins, whose rail already carries the archive glyph this page declares in `SettingsRoot`.

The `{ type: 'archived', archivedSessionIds }` follow increment already carries the complete set, so a restore reuses it: the Remote answer installs locally, and every other Client converges through the same increment. No frame type, persisted field, or `SESSION_FORMAT_VERSION` change accompanies the verb.

## Alternatives considered

**An Unarchive action in the Session row menu.** The row menu owns Archive, but a restored Session has no visible row until it is restored, so the action would have nowhere to live in the state that needs it; a disabled entry on every row would be decoration without a subject.

**A second frame type carrying a removal delta.** The existing `archived` increment is a complete-set replacement, so a removal delta would add a redundant representation that every consumer would have to merge; the full-snapshot posture is what lets the archive echo be reused unchanged.

**Rendering an archive entry whose Session is gone as a disabled row.** Such a row could explain the gap but not restore anything, and the registry and the Remote still accept the id, so the page lists what it can act on and leaves the orphan id to a future cleanup surface.

**A Session-existence probe on unarchive, mirroring archive.** The check exists to keep added references resolvable, and a removal cannot break that invariant; probing would only turn restoring a deleted history into a failure with nothing to repair.

## Consequences

The archive set stays the only durable state a restore rewrites; the `workspace` domain version, the Session log, and the Workspace accounting slot are untouched, and a restored Session returns to its recorded position. Archive and unarchive now enforce different Session checks, a deliberate asymmetry recorded in the [Workspace registry limitations](../../../../packages/workspace/workspace/README.md#known-limitations-and-deferred-work).

The restore surface is bounded by what the page can display: an archived id whose summary is not loaded has no row and no Unarchive action even though the registry method and the Remote accept it, so the page reports an unavailable set instead of an empty archive. Restoring through automation stays available, and a future cleanup surface can address the remaining orphan entries.

## Testing

`packages/workspace/workspace/tests/workspace.spec.ts` pins the registry method: removal keeps the surviving archive order, the accounting slot stays, a repeat and a never-archived id neither rewrite the medium nor emit a change, an entry whose Session is gone resolves without a persistence listing, and the surviving set reloads across a restart. `packages/api/workspace-controller/tests/workspace-controller.host.spec.ts` pins the verb's idempotent complete-set answer and the unchanged `archived` follow increment, and `packages/api/workspace-controller/tests/model.client.spec.ts` pins the Client model echo and its refusal to install a failed answer, plus the four stale-reply races: overlapping archive or unarchive requests settling out of order, and a follow increment or baseline arriving while a reply is in flight. `packages/client/ui-settings-unarchive-sessions/tests/components.client.spec.tsx` pins newest-first ordering, the ungrouped label, the hidden entry whose Session is gone, the reading and empty states, search, and the console diagnostic on rejection, while `tests/browser-plugin.client.spec.tsx` pins the section registration.

## Related

- [Session archive (registry-global set)](../../archived/feature/2026-07-31-session-archive-global-set.md) — the frozen record of the archive set, the follow increment, and the predicted restore surface.
