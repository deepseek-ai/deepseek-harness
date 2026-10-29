# Agent Note: Session writable-directory effects

Status: implemented

English | [中文](2026-10-26-session-writable-directory-effects.zh.md)

## Problem

Memory plugins need agent writes outside the workspace without granting every Session the same directory. Deployment-wide roots cannot express a plugin enabled for only one Session or a grant that ends when that plugin unloads.

## Decision

The sandbox-policy service owns effect-scoped directory registrations keyed by live Session identity. Configured grants remain shared; runtime grants apply only to their named Session. Each resolution captures the active union, and existing request-context logging records the directories advertised to the model. Resume and fork require new registrations rather than restoring authority from historical text.

Registration disposal affects subsequent operations, not already-resolved calls or running processes. This deliberately permits persistent terminals and PTC environments to retain their launch grants until they stop. The requirement is to update ongoing Sessions' future executions without coordinating process cancellation or losing retained state. This narrows the different-policy reuse restriction in the [retained PTC sandbox decision](2026-10-08-persistent-ptc-sandbox.md) for additional directories only; mode-change invalidation and one-time escalation cleanup remain unchanged.

Missing, non-directory, and symlinked extra paths stop execution with `SandboxInvalidRootError`, which identifies the path and its problem. Silently skipping a path would hide an invalid grant and let execution proceed with permissions different from those requested. Registration checks path spelling; enforcement validates the physical directory on each call without retaining an earlier resolution. Symlinks remain disallowed, keeping configured and plugin grants under the same validation rules.

## Alternatives considered

**Shared mutable extra roots.** Enabling memory in one Session would also authorize unrelated Sessions using the same service.

**Immediate process revocation.** Existing sandboxes apply grants at launch. Stopping and recreating processes would discard terminal or PTC state and require cleanup coordination beyond the accepted future-operation requirement.

**Persist runtime grants as Session permissions.** Replaying such grants could authorize directories after the plugin that supplied them has been removed. The active plugin composition owns these grants.

## Consequences

Independent registrations for the same directory survive another owner's disposal. Removing a registration cannot revoke overlapping configured or workspace access. A running process may retain a removed grant, or lack a newly added grant; a new process uses the current policy. Windows subprocesses ignore extra roots while file tools enforce them; the [Windows scope decision](2026-10-29-windows-file-tool-directory-grants.md) records this limitation. Focused coverage checks Session isolation, duplicate ownership, plugin unload, filesystem denial and mutation, request context, and retained PTC launch permissions.
