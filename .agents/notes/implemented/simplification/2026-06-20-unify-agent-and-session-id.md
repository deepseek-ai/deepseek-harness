# Agent Note: Unify the agent id and the session id

Status: implemented

English | [中文](2026-06-20-unify-agent-and-session-id.zh.md)

## Problem

A live agent/session pair needs one identity for registry routing, event sourcing, and persistence. Giving the factory independent `agentId` and `sessionId` inputs would permit pairings no production path can use, while forcing every consumer to choose or translate between two names for the same lifecycle.

ACP uses the same value for both identities. Stdio and hooks also operate on the session event stream and need the corresponding live agent directly; no production path reattaches one live agent object to several sessions or drives one session through several agent ids.

The [agent-scope runtime](../../../../packages/core/agent-loop/README.md) uses one `AgentCreationTransaction` for create and resume, and agent/session entries share the same final-entry collision rule. A second identity would not represent separate liveness, rollback, or quiescence; it would only add API and translation state around the same transaction.

Session identity likewise has one home in `Session.header.id`; `Session.id` is a derived accessor rather than independent state that needs duplicate validation.

## Decision

An agent's registry id equals its session id. `CreateAgentOptions` accepts one `sessionId` used for both final registry entries; resume registers the agent under `resumeSessionId`; in-process subagent creation uses the child session id; and `Session.id` derives from `header.id`. A remote ACP run has no local agent/session pair: it keeps one parent-minted lifecycle id while the child server's wire-local session id remains private to ACP calls. The existing creation transaction, final-entry collision checks, and exact-entry detach semantics remain; maps and fields whose sole job was translating between local ids are gone.

The config-driven path keeps `agents[].id` as a stable configuration label, not a live routing identity. An ordinary fresh start mints the combined id `${label}-session-${randomUUID()}` so durable restarts do not collide. A coupled app may pre-mint and pass an exact `sessionId`: first use creates it, while an AgentLoop remount with an already-present persistence service resumes materialized history under that same identity. `resumeSessionId` instead requires an existing persisted identity. The two exact-id inputs are mutually exclusive. Stdio uses the resume-or-create form so its config-created agent and UI share one opaque identity across loop reloads instead of guessing from a prefix. Logs may use the stable label while all live and durable lookups use the one `SessionId`.

`agent/created` and `agent/disposed` remain. They are paired publication lifecycle events, not identity aliases; any later consumer-free removal needs its own proposal after a fresh search.

## Alternatives considered

**Keep separate routing and log identities.** A stable configured label plus a fresh durable conversation is useful, but it does not require two live identities: the label can remain configuration/display metadata while the combined per-run `SessionId` owns routing and persistence. Keeping two ids would preserve translation maps and permit impossible pairings without adding lifecycle capability.

## Verification

- Agent create/resume and subagent creation carry one identity, and `Session` stores it in one place.
- The creation transaction retains final-entry collision, exact-entry detach, rollback, and quiescence coverage without identity-specific lifecycle state.
- ACP, stdio, hooks, bash ownership, persistence, and lineage use the shared `SessionId` directly. The ACP subagent backend mints its lifecycle id in the parent namespace because a child server's returned session id is only server-local; the ACP bridge verifies exact `Agent` ownership from the forward session map; and JSON-RPC forwards only lifecycle events whose service-snapshotted `local` flag is true, obtains the delegating parent from the scoped event carrier, and keeps no child identity or lineage cache.
- The config-driven resume-or-create policy is explicit and covered across a durable restart.
- A production listener search kept `agent/created`/`agent/disposed` and their publication semantics.

## Consequences

This forecloses latent multi-session-actor and session-handoff designs and makes persisted client-chosen session identity the registry identity. If separate routing identity becomes a real requirement, it needs an explicit lifecycle design rather than an unconstrained caller-supplied pair.
