# Agent Note: Forge state in the Session list

Status: implemented

English | [中文](2026-10-20-forge-session-list.zh.md)

## Problem

The [forge panel](2026-10-09-forge-panel.md) named a Session's branch in a chip beside the Session title. The header's action row does not shrink, so a long branch overlapped other header entries such as the background task label. Finding which Sessions work in their own worktrees, and which of their change requests need attention, also meant opening each Session's tab. The Session list offers seats for row icons and a hover card section, `sidebar.session.row.trailing` and `sidebar.session.row.hover`, whose occupants must not load or bind Sessions. A row needs two kinds of fact: what the Session log records, which is the worktree the panel created and entered and the change requests the Session binds, and what only polling knows, which is each change request's state and checks.

## Decision

The chip beside the Session title is gone, and the tab's first row names the branch. A Session row shows, after its time, a branch glyph while the Session works in the worktree the panel created for it, and the glyph of its most urgent change request: one needing attention first, then open, draft, not yet polled, merged, and closed. An open change request's glyph keeps the row's subdued color with a dot for its checks; merged and closed ones keep their state colors. The row's hover card section names the worktree branch and what it started from, then up to three change requests with their state and checks, and how many more there are.

Log facts reach the list as projection client views, which the Session summary carries. The `forgeWorktree` projection also records the Session's directory from its header and each `working-directory/change`, and its view is the created worktree while that directory is the worktree or lies below it, else null. The `forgeChangeRequests` view lists the bindings without status, as the [binding decision](2026-10-09-session-change-request-bindings.md) intended. The projection cache keeps both for Sessions that are not loaded.

Polled states reach the list through the `forgePanel.changeRequestStates` stream. One Host run serves every stream and stops with the last one. It lists Sessions through `sessionQuery` without loading them, takes the visible bindings of loaded Sessions from `ctx.forgeSession` and those of other Sessions from their cached summary, follows binding changes of loaded Sessions, and subscribes to each bound change request through the shared `ctx.forge.watch`; closed requests use the idle polling cadence, and merged requests remain subscribed for explicit refresh. Every changed state is stored in the `forge_panel_change_requests` storage domain under the SHA-256 digest of its URL, so a restart shows the last known states before the next poll, and unbound stored states are dropped only when every listed Session has known bindings. A stream sends a `baseline` of the states its caller may read, then `changed` frames, filtered through Remote access.

The browser keeps one source of states for every row and hover section: the first subscriber opens the stream, the last one closes it, and a transport reset reopens it.

## Alternatives considered

**Leaving change requests to the tab.** The forge panel first rejected a Session-row hover section because, for one Session, it repeated the tab. The list compares every Session at once, which no tab does, and the hover section adds only the facts a row's glyphs summarize.

**Keeping the branch beside the Session title.** Truncating the chip would hide the branch name, and the header shows only the open Session; the list shows every Session, and the tab names the branch in full.

**Polled states in a projection.** Projections fold the Session log, and polled states are not logged. A projection would either log every poll, adding events that no model request needs, or depend on process-local state that a replay cannot reconstruct.

**Following every listed Session's panel.** A panel inspects its checkout with Git in the Session's execution world and probes sign-in; the list needs only bindings and change request states.

**Loading listed Sessions to read their bindings.** Listing would replay every Session log; the cached summary answers without loading.

**Keeping the states only in memory.** Every row would show unknown states after a restart until each change request is polled again. The stored states are derived data, so a record that fails its schema is set aside instead of failing the run.

**A branch line for a Session that works in its project directory.** Reading that branch needs Git in the Session's execution world, which the list must not reach without loading the Session.

## Consequences

The list shows every Session's worktree and change request states without loading a Session, a restart shows the last known states at once, and the header no longer overlaps. While a row is shown, every open change request that a listed Session binds is polled, so many Sessions with open change requests mean more requests to the code host; closed requests keep polling at the idle cadence, and merged ones stop automatic polling. A Session without a cached summary shows its worktree and change requests in the list only after it is opened, and one last used before this change shows its worktree only then, because the `forgeWorktree` state changed and older cached rows are discarded. Checks that finish while no row is shown produce no notification.
