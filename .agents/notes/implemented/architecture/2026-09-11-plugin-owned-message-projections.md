# Agent Note: Plugin-owned message projections

Status: implemented

English | [中文](2026-09-11-plugin-owned-message-projections.zh.md)

## Problem

The dedicated [image-offload event](2026-09-10-image-offload-events.md) changes derived message content without replacing nodes. Implementing its image traversal and target validation inside Session makes each feature-specific message transformation a core change. The ordinary session-projection registry derives domain state but does not participate in canonical model-history derivation.

## Decision

The event-owning plugin supplies a pure `SessionMessageProjection`: one event type and a synchronous interpreter of the preceding history. It validates the complete durable payload and returns immutable updates for existing messages, preserving their identities. Session owns atomic acceptance, shared live and detached folding, and content-generation cache invalidation. It contains no image selection or image projection implementation.

The `@messageProjection` tag on the owning `SessionEventMap` member generates the required-interpreter inventory. Missing definitions reject append, seeded creation, restore, and pure folding. This inventory does not make unknown third-party event names readable or change `ignorable` compatibility. A projection event cannot also declare a surface operation.

The compaction-image-offload plugin registers its definition through a fiber-owned `ctx.sessions.registerMessageProjection()` effect. Each event has one registered owner. Removing a definition invalidates pending committed decisions and cached reads that used it; a replacement definition requires restoring the session. Rejected, uncommitted candidates retain no interpreter dependency.

Detached readers pass definitions explicitly. The current Session format catalog assembles the same browser-safe plugin exports for persistence validation and offline queries. This static assembly does not mount recovery listeners. Live sessions use the registered composition, while compaction invariants borrow that composition's definitions. No process-global registry or import-time registration is involved.

The image event payload and required-on-read semantics remain owned by the image-offload note. Its indexes, selection policy, retry behavior, and SDK recordings are unchanged; this decision partially supersedes that note's core-owned interpretation.

## Alternatives considered

**Keep image interpretation in Session.** That gives detached callers an implicit built-in, but turns a plugin-owned transformation into core event-specific code. Explicit assembly preserves deterministic replay without assigning the algorithm to core.

**Use the ordinary session-projection registry.** Its folds expose domain state after commit. They cannot veto an invalid append or supply canonical `deriveMessages()` content without another integration point.

**Transform only the outgoing request.** Compaction, fork, offline replay, and request invariants also derive messages. A send-time transformation does not cover these consumers.

## Consequences

Adding a content-changing event requires its declaration, pure interpreter, live registration, and detached assembly entry. Ordinary log-only events need none of this. Consumers of the pure fold use the generic `projectedMessages` result. The event envelope and stored image decisions remain unchanged, so no structural Session format version is added.

Tests cover missing interpreters, generic atomic projection, loaded windows, restore and fork, duplicate registration, fiber disposal, cached and pending reads, and rejected candidates. Image-specific tests remain with their plugin. The catalog checks that every generated required type has a detached interpreter and rejects invalid image references. Existing TypeScript and Python image SDK recordings exercise the same durable event through shipped profiles.
