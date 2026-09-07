# Agent Note: Stable Turn-process ordering

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-26-stable-turn-process-order.zh.md)

## Problem

Turn-process eligibility changes as Assistant output streams, becomes a final answer, or is invalidated by a Tool call, Retry, or later Step. Ordering existing Chat Nodes from that mutable range moved the initial System prompt and pre-User Context across the opening User, so one logical row appeared at different transcript positions during a Turn.

## Decision

Existing Chat Nodes keep one presentation order throughout a page lifetime. Their positions depend on durable anchors, node kinds, and the opening human input, never on the mutable process start or answer boundary. Dependency replay after loading older history retains an already projected System prompt's anchor. A newly projected process control may be inserted between existing rows, while completion, Retry, later Steps, pagination completion, and manual disclosure only change visibility or add new evidence.

System prompt is independent of Turn Process: the initial prompt remains visible above the opening User and never receives process-member or process-hidden state. A later prompt first projected from a partial window retains that position when earlier request history loads. Context injection remains process content. When a Context or another potential process row has an event anchor before the opening User, Chat places it after that User from its first projection; once available, the process control occupies the stable position between the User and those rows. Without opening human input, the control stays before the earliest process candidate from its first appearance.

The existing [Turn-process folding decision](../feature/2026-08-14-web-turn-process-folding.md) continues to own membership, completion, persistence, focus, and pagination behavior; this note supersedes only its earlier decision to fold System prompt and to defer pre-User process ordering until a mutable range included those rows.

## Alternatives considered

**Keep System prompt inside Process but preserve its original position.** Rejected because a disclosure below the opening User would control content above itself, and collapsing would remove the request-wide instruction that visually frames that User message.

**Exempt only System prompt.** Rejected because pre-User Context could still move when answer qualification changed, preserving the same class of visual discontinuity.

**Reparent process rows under the disclosure.** Rejected because moving keyed rows across React parents remounts stateful renderers.

## Consequences

The stable first-Turn presentation is `System prompt → User → Process → Context and other process rows → final Assistant`. Pre-User injected Context can therefore differ from raw event order, but it uses that semantic position from its first render. Tests cover the initial state, process appearance, completion collapse, manual expansion, and content-only answer-boundary changes.
