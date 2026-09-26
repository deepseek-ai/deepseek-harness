# Agent Note: Model agent availability and Team targets

Status: implemented

English | [中文](2026-09-15-model-agent-availability-and-team-targets.zh.md)

## Problem

Team operations accept member names, but returning both names and Session UUIDs invites the model to choose an unusable address. Loaded and stored agents also have distinct internal statuses despite requiring the same model action to continue work.

## Decision

The Team tool adapter returns `target` from the existing member name and omits member Session IDs from creation and listing results. Messaging, interruption, and task assignment consume that same name. Task `ownerName`, task IDs, and message IDs retain their existing meanings. Internal services, Web views, and persisted Team records retain Session identity.

Normal subagent tool results and Team service views project loaded-between-turns and stored agents as `inactive`. Only an executing turn is `running`; Team retains `provisioning` and `failed` for member creation, and ordinary subagent diagnostic rows retain their read-failure reasons. Interruption projects its previous status by the same rule. Availability does not report task outcomes or waiting dependencies.

The Team service owns roster and interruption availability for both tools and Web. The ordinary subagent projection belongs to its list tool. Runtime loading, cold resume, interruption authority, and mailbox delivery retain their existing behavior. Ordinary subagents continue to use `agent_id`; stable subagent names and historical-data handling are deferred. No persistence type or Session format changes.

## Alternatives considered

**Add stable names to ordinary subagents now.** This requires a durable naming policy and explicit handling of historical children without names. It is independent of removing misleading Team identities and model status distinctions.

**Merge internal runtime states.** Residency determines whether delivery starts a loaded agent or restores one from storage. Underlying Agent status and registry presence retain that distinction; Team views expose only turn availability.

## Consequences

Models can copy a Team result's target directly into applicable operations. They lose member UUIDs and residency details from these tool results; neither is needed for Team addressing. Ordinary subagent and Team addressing remain different until a separate naming decision.

Focused service and tool tests cover every status projection, returned-target operations, diagnostic rows, and live versus stored children. Recorded headless Team and SDK subagent scenarios pin the assembled model output and schemas. The [Agent Teams decision](../feature/2026-08-05-agent-teams.md) continues to own roster durability, scoping, and authority.
