# Agent Note: New Session reuses a blank Session, matching a requested preset

Status: implemented

English | [中文](2026-10-20-new-session-blank-reuse-by-preset.zh.md)

## Problem

In 0.2.0-rc.2, New Session (the sidebar button, the Workspace "+" button, and the shortcut, all calling `uiWorkspace.startSession` without options) reused the Workspace's first blank Session. PR #5775, first released in `dsh-v0.2.1-alpha.2`, changed it to create a fresh Session and Agent on every call, so that New Session composes the current preset definition after the user changes one instead of keeping a reused blank's earlier composition ([upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.1/new-session-generations/guide.md)).

A blank Session that is not current is hidden from the Session tree, and New Session is the only way back to it. After that change, a user who types a draft into a blank Session, switches to another Session, and clicks New Session lands in another empty Session; the original draft stays in localStorage under the old Session id, but no control returns to it. 0.2.1-rc.2 therefore loses New Session's unsent drafts.

The Creator entries (`startSession(…, { agentPreset: 'cordis', prompt, clearPreviousDraft: false })`) also reuse the first blank Session and switch it to Creator: an existing ordinary draft stays under Creator mode and the Creator prompt is not filled in, and New Session can likewise take over a Creator blank.

## Decision

Only the Client (`ui-workspace`) changes; the Host is unchanged:

- `startSession` without options takes the reuse path again and follows the same rule as `openWorkspace`, `connectWorkspace`, and `startSession` with options.
- `createInWorkspace` names the first unstarted, unarchived blank Session that is still a Workspace member. A request that names a preset skips a blank whose listed preset (`projectionValues.agentPreset`) is a different one, while a blank with no listed preset remains eligible; a request without a preset may name any blank, which the Host switches to its default preset. The Host creates a Session when no blank is eligible.

As a result, New Session returns to the original blank Session with its unsent draft, and preset flows such as the Creator entries do not take over a blank that lists another preset, so an ordinary draft is not moved under Creator. No persisted state is added, and the Client does not read the preset roster.

## Alternatives considered

**Revert the PR #5775 change completely, reusing the first blank for every request.** Drafts come back, but preset flows such as the Creator entries take over the blank holding the user's ordinary draft, switch it to Creator, keep the draft there, and cannot fill in their prompt.

**Keep creating a fresh Session and move the abandoned blank's draft into it.** This needs rules for which blank to move from when several exist, how to treat attachments, and whether to archive the old Session, which is more change and state than reusing blanks.

**Let a request without a preset reuse only a blank of the Host default preset.** The Client does not know the default preset and would have to request the `agentPresets.list()` roster.

**Record a persisted source-to-blank-Session map in the Client.** It duplicates the preset each blank already records and must handle stale entries and per-origin isolation.

**Clear the existing draft in place when the preset changes (`clearPreviousDraft: true`).** It deletes a draft the user was writing in the other mode.

**Also change the Host to always call `presets.select` when reusing a loaded blank.** It fully keeps #5775's goal but is outside this Client-only fix; see Deferred work.

## Verification

- `ui-workspace` unit tests: New Session without options returns to the existing blank; a request without a preset reuses any blank, a request with a preset reuses only a blank listing the same preset, and a new Session is created when none matches. `navigation.ts` has 100% per-file coverage.
- Regression localization: the same unit probe on the PR #5775 commit that made this change and on its parent, plus a browser reproduction on builds of both, confirmed that the draft loss comes from that change.

## Consequences

- New Session no longer guarantees the current preset definition: a reused blank whose Agent is still loaded in the Host with the same preset id keeps its creation-time composition; a blank resumed after a Host restart composes the current definition.
- New Session may reuse a blank left by a preset flow such as the Creator entries; the Host switches it back to the default preset and its draft stays.
- The [new-session-blank-reuse](../../../../docs/upgrade-guide/v0.2.1-rc.2/new-session-blank-reuse/guide.md) upgrade guide records the change relative to 0.2.1-rc.2.

## Deferred work

- Host `reuseLive` (`packages/api/session-controller/src/agent.ts`) returns the loaded Agent unchanged when the preset id matches and does not call `presets.select`. `select` decides whether a definition was registered again by comparing `Generation` objects: when they are the same it does nothing; when they differ it recomposes under the same Session id with the current definition and records `agent-preset/selected`; on a started Session it throws `agent-preset/locked`, and the caller creates a new Session instead. Removing the `target === current` early return and always calling `select` keeps drafts while meeting #5775's goal that New Session composes the current definition; it needs a Host test, and updates to the `reuseLive` JSDoc and to the upgrade guide's statement that the current preset definition is no longer guaranteed.
