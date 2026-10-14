---
kind: upgrade-guide
description: "New Session creates a fresh Agent instead of reusing an existing empty Session."
---

# Start a fresh Agent with New Session

English | [中文](guide.zh.md)

## Change

In Web and Desktop, New Session creates a fresh Session and Agent using the current preset definition. It previously reused an existing empty Session in the workspace, which could retain an earlier preset definition.

Client calls to `uiWorkspace.startSession(workspaceId)` follow the same behavior. Workspace reconnection through `openWorkspace` or `connectWorkspace` still reuses an eligible blank. Calls with draft-preparation options preserve their existing reuse and content rules. Existing Agents retain their preset composition; global optional tools update on their next request when a bundle is switched.

## Migration

1. After changing a preset definition, use New Session to create an Agent with the current definition. Continue in an existing Session when its retained preset composition is intentional.
2. Client integrations that reconnect a workspace should use `openWorkspace` or `connectWorkspace`. Keep explicit draft-preparation options when preparing an existing draft.
3. Confirm that the new Agent uses the updated preset definition; no persisted Session files or profile patches need rewriting.
