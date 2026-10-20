---
kind: upgrade-guide
description: "New Session reuses a blank Session in the Workspace again instead of creating a fresh Agent on every call."
---

# New Session returns to its blank Session

English | [中文](guide.zh.md)

## Change

In 0.2.1-rc.2, New Session in Web and Desktop, and `uiWorkspace.startSession(workspaceId)` without options, created a fresh Session and Agent on every call ([earlier guide](../../v0.2.1-alpha.1/new-session-generations/guide.md)). The blank Session it left behind is hidden from the Session tree, so its unsent draft could no longer be reached.

New Session now reuses the first unstarted, unarchived blank Session in the Workspace, which the Host switches to its default preset, and creates a Session only when none exists. `startSession` with options, `openWorkspace`, and `connectWorkspace` follow the same rule; a request that names an Agent preset skips blanks whose listed preset is a different one, so preset flows such as the Creator entries do not take over another preset's draft.

A reused blank whose Agent is still loaded keeps the preset composition it was created with. New Session no longer guarantees the current preset definition.

## Migration

1. After changing a preset definition, start the conversation in a Session whose Agent was composed after the change, for example by restarting the Host before using New Session; a blank resumed after a restart composes the current definition.
2. Client integrations that must not take over a blank listing another preset pass `{ agentPreset }` to `startSession`, `openWorkspace`, or `connectWorkspace`.
3. To confirm, type a draft after New Session, open another Session, and use New Session again: the same blank opens with the draft.
