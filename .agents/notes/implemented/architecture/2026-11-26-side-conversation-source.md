# Agent Note: A side conversation records its source as `parentSession`

Status: implemented

English | [中文](2026-11-26-side-conversation-source.zh.md)

## Problem

A side conversation is an ordinary fork opened beside its source; listing a source's side conversations needs a durable source relationship. The [independent-forks decision](2026-10-23-independent-session-forks.md) left ordinary forks without a durable source id, so nothing durable connected a side conversation to the conversation it was forked from. The only durable relationship field, `SessionHeader.parentSession`, was written for subagents alone, and three consumers read its presence as proof of delegation: auto-review granted the sender matching `parentSession` direct-parent instruction authority, IM resolved a child's hosted chat and grants by walking `parentSession`, and the session log export packed every `parentSession` descendant as a subagent log.

## Decision

A fork with `origin: 'side'` records its source as `parentSession` on the Host header and as `parentSessionId` on the Client placeholder; ordinary forks still record nothing. `parentSession` means the Session that created this one; what kind of child it is comes only from `origin`.

- `origin: 'subagent'` is the sole classification for delegation. [auto-review](../../../../packages/experimental/auto-review/src/index.ts) grants direct-parent instruction authority only to a subagent's delegating parent, [IM](../../../../packages/experimental/im/src/sessions.ts) follows only subagent creators when it resolves a hosted chat, and the [session log export](../../../../packages/session-query/session-log-export/src/archive.ts) packs only subagents as descendant logs; a side conversation and an ordinary fork that retained its source id before the independent-forks decision get neither. Every other reader of `parentSession` already classified by `origin` or uses the field only as a relationship: lineage tracing, the session query tool's parent column, and telemetry's `session.parent_id` include side conversations.
- The left Sidebar resolves the viewed Session's row through side sources as it does through subagent creators, so a side conversation open in the main view highlights its source; side rows stay flat and unlisted.

## Alternatives considered

**A separate `sourceSession` header field.** Additive and safe for every existing reader, but it is a second relationship field with one more persisted header member, a Client summary field, and its own catalog and migration acknowledgements. The three consumers above needed an `origin` check either way, because a subagent whose creator is a side conversation already walks through one.

**Record the source for every ordinary fork.** Nothing technical prevents it: historical ordinary forks carry `parentSession`, and the released reader requires a parent for inherited delivery acknowledgements, so the field would only widen compatibility. It reverses the product choice that an ordinary branch is an independent conversation, which no current consumer asks for; the side conversation is the one child whose source needs the relationship.

## Consequences

- A reader that keys on `parentSession` alone treats a side conversation as delegated work. Classification reads `origin`; `parentSession` is a relationship.
- Side conversations created before the source was recorded carry no `parentSession`. Listing them is outside this decision.

## Testing

[`session-fork.host.spec.ts`](../../../../packages/api/session-controller/tests/session-fork.host.spec.ts) and the Client manager and service specs cover the recorded source and placeholder; the auto-review, IM, session log export, and Workspace tree specs cover each consumer's `origin` rule.
