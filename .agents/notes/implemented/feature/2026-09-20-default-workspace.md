# Agent Note: First-use default Workspace

Status: implemented

English | [中文](2026-09-20-default-workspace.zh.md)

## Problem

A new installation requires a directory choice before the user can send a first message. Removing that prerequisite must preserve the Session's fixed working directory and must not treat hidden or archived history as a new installation.

## Decision

Startup waits for complete Workspace and Session baselines. When both lists are empty, the Client asks the Host to prepare the default Workspace, then creates or reuses and selects its blank Session. Input stays unavailable until a Session exists and uses the ordinary composer pipeline thereafter. [Session scope and provisioning](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md) owns blank-Session reuse and provisioning rationale.

The [Workspace registry](../../../../packages/workspace/workspace/README.md#first-use-workspace) owns eligibility and directory preparation. All live Sessions, persisted headers, and archived identities count, including entries absent from the sidebar. The operation shares the registry mutation queue and rechecks Session history after directory preparation because Sessions can start independently.

The Host controller resolves the Documents location; the registry receives a directory resolver with no locale dependency. The resolver runs inside the mutation queue only for eligible creation, so repeated requests reuse the durable Workspace without another OS lookup. A durable Workspace id records successful initialization independently of that name. Renaming, changing language, restarting, or deleting the registration cannot initialize another default. The marker commits with the registration, so a failed registration can retry. Directory contents remain subject to the existing [metadata-only deletion policy](2026-07-27-workspace-registration-deletion.md).

The naming half of this decision is superseded: [language-neutral default Workspace naming](2026-09-23-language-neutral-default-workspace-naming.md) fixes the directory name and stored title and localizes only the on-screen label.

Ineligible first use returns no Workspace without a failure dialog. Preparation failure offers the existing folder picker; startup does not retry on later list notifications. A successful registration survives Session creation or prompt failure. Selecting either the default or a manually picked Workspace never submits a message.

## Alternatives considered

- Creating only when sending avoids unused directories but requires a separate local draft, transfer into a Session, and coordination of the first submission. Startup creation accepts the early filesystem effect and uses ordinary Session input throughout.
- Falling back to `<home>/Documents` when system lookup is unavailable would choose an unverified Documents location; deployments that need another directory use the explicit Host override.
- Inferring first use from visible sidebar rows would ignore archived, hidden, and cwd-less Sessions.
- Using the initialization directory's path as the initialization marker would allow renaming, relocation, or deletion to create another default.
- Changing a Session's cwd after creation would change the meaning of its recorded tools and attachments.

## Consequences

Opening a new installation can create a directory and blank Session before the user sends a message. Directory authorization and preparation failures can appear during startup. Preparation remains a Host responsibility for both Desktop and remote Web clients, so remote users use the Host account's Documents location. Unavailable Documents lookup fails with the same folder-selection recovery as directory creation failure.

The feature preserves [reference-owned Client Session lifetimes](../architecture/2026-09-15-client-session-references.md) and requires no agent-loop or Session-event change. Registry and client tests cover retries, hidden history, concurrency, and startup cancellation; the [browser scenario](../../../../apps/web/tests/default-workspace.e2e.ts) verifies the assembled startup, reload, first-send, and picker paths with an isolated Documents directory and recorded Session replay.
