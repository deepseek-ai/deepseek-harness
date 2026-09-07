# Agent Note: User and steering bubbles drop the branch action

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-user-bubbles-drop-the-branch-action.zh.md)

## Problem

Every user and consumed-steering bubble rendered the branch control under the completed-turn-tail gate of the [completed-turn-tail decision](../bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.md). On those bubbles the gate is effectively permanent: a turn-opening user message is followed by its own turn's nodes, and a consumed steering message is mid-turn by construction, so the control could enable only when the turn ended with no node after the message at all — a cancel before the first model event. Readers therefore saw a control that never enables, with a tooltip promising a state the button cannot reach. The affordance also misled when read at all: a fork at a message seq cuts at the containing `turn/end`, so "branch at my message" includes the answer below it — the opposite of the branch-to-re-ask reading a control on one's own bubble suggests.

## Decision

User and steering bubbles render no branch action. `MessageItem` loses its fork props, `PendingSteeringBubble` loses its `showBranch` special case, and `messageBranchSeqs` narrows to `assistantBranchSeqs`: only a completed turn's transcript tail that is the turn's own content-text assistant may fork. The branch affordance lives solely under the settled answer.

A turn containing a steer keeps its fork point unchanged: fork is a log-prefix cut at `turn/end`, and the steer is model-visible history the child must inherit, so the settled answer of a steered turn forks like any other. The assistant-side gate and its visible-but-unavailable presentation are also unchanged — under an answer, unavailable is a transient, reachable state (a trailing tool or error row currently owns the tail), which is exactly what the tooltip is for.

## Alternatives considered

**Hide the control on message bubbles only while ineligible.** Rejected: it preserves the near-unreachable enabled case at the cost of an icon that appears on one's own bubble only when a turn died before producing anything, an inconsistency not worth the case it serves.

**Keep the visible-but-unavailable control (status quo).** Rejected: the [completed-turn-tail decision](../bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.md) chose visibility so the tooltip could explain a boundary the reader can reach; on user and steering bubbles the boundary is unreachable in practice, so the explanation props up a control that should not exist there.

**Branch-before-the-message semantics on user bubbles.** Out of scope: re-asking from one's own prompt needs a cut before the message plus composer prefill, a different Host operation. Removing the current control keeps that seat free for such a feature instead of squatting on it with opposite semantics.

## Consequences

The only fork handles are the enabled branch controls under settled answers. A turn cancelled before any node followed its message loses its only handle and has no fork point, matching turns whose tail is a content-free interrupted node. Web aria goldens across `apps/web` drop the user-bubble disabled-branch row and its hidden explanation text. Package tests pin that user and steering bubbles render no branch control and that a steering-tail turn leaves the narration's control unavailable.
