# Agent Note: Borrow Auto review inputs until serialization

Status: proposed

English | [中文](2026-10-18-borrow-auto-review-inputs.zh.md)

## Problem

[`snapshotAutoReview()`](../../../../packages/experimental/auto-review/src/index.ts) reads frozen Session history, request headers, and tool arguments, but also copies `session.surface.nodes` and freezes its private result. Its only caller, `classifyRisk()`, immediately serializes that result without an intervening await or publication.

## Proposal

Borrow `session.surface.nodes` and return the readonly intermediate result without another `deepFreeze()`. Preserve all action validation and the final `GenerateOptions` freeze. [Session-owned immutability](../../implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.md) and [request-only input freezing](../../implemented/architecture/2026-09-17-persistence-attribution-policy.md) remain unchanged. This removes a private array allocation and freeze traversal without changing the reviewer request.

## Alternatives considered

**Keep the intermediate snapshot.** A future retained or asynchronous reader would need stable inputs. No current consumer retains this object or awaits before rendering.

## Acceptance criteria

Native and PTC requests retain identical text, source filtering, and action checks. Existing request-freezing and cancellation assertions pass. Serialization does not mutate borrowed Session or execution data.

## Risks

Future asynchronous work or publication of the intermediate object would require reconsidering ownership. Removing the final request freeze or the source owners' snapshots is outside this proposal.
