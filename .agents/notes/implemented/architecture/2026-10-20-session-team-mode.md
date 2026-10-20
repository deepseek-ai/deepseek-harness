# Agent Note: Team availability is selected per Session

Status: implemented

English | [中文](2026-10-20-session-team-mode.zh.md)

## Problem

A plugin-level Team switch requires users to change the shared profile before choosing collaboration for one conversation. It can disable another Session’s capability and leaves a second control beside the Session selection. Ordinary tasks still need their existing tool catalog, and disabling collaboration must not discard task history or children.

## Decision

The base bundle loads the Team service and task tools, and the Web bundle loads the Team UI. The packages belong to the subagent and client product groups. A saved root-Session selection gates task tools, Team guidance, and the shared board throughout the tree; new Sessions default off. Ordinary subagent creation, communication, and navigation remain available.

The model and reasoning menu owns the user’s selection. The existing Subagent panel displays members above shared tasks. Disabling Team keeps the journal and children; re-enabling restores the board. Historical task boards without a saved selection stay enabled. Profile loading removes the retired optional bundle selection, retaining row overrides.

This supersedes the explicit-composition choice in [Agent Teams](../feature/2026-08-05-agent-teams.md). Its durability, ownership, and lifecycle decisions remain active. [Optional bundles](../process/2026-09-15-shipped-optional-bundles.md) still governs other experimental features.

## Alternatives considered

**Keep both switches.** Capability installation remains a prerequisite that the conversation control cannot explain or resolve; users must manage shared profile state for a Session decision.

**Hide the plugin card without loading Team.** New profiles would have no way to obtain the capability. Loading experimental packages in the default profile would violate product isolation; moving them to their owning product groups makes the delivered support explicit.

## Consequences

Default profiles carry the Team implementation while exposing no task tools until enabled. The removed package names require custom compositions to migrate; durable event names and task data remain unchanged. [The upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/session-team-mode/guide.md) owns those steps.

Verification covers default startup, new-Session opt-in, independent roots, persisted selections, retained tasks, old profile migration, and absence of the plugin switch. Product-isolation checks retain an unrelated experimental plugin as their negative control.
