# Agent Note: Goal-round wrap-up message

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-02-goal-round-wrapup-message.zh.md)

## Problem

An autonomous goal round that reported `update_goal` `complete` or `blocked` concluded the physical turn at the tool result, so the model never spoke after the call. Sessions ended on a bare `update_goal` card, and internal testers read that as the agent stopping mid-sentence: the model's pre-call text routinely announces a report ("goal achieved, marking complete:") that never arrives, because the standard tool-use expectation is one more assistant message after a tool result and neither the goal-round prompt nor the tool description said the call was terminal. The hard stop came from the [goal-tool decision](../feature/2026-07-19-model-facing-goal-tools.md), whose turn-stop clause this note supersedes.

## Decision

A goal-round `complete` or `blocked` success no longer calls `concludeTurn()`. Instead the tool defers one wrap-up context onto its own result: a `{ kind: 'plugin', plugin: 'tool-goal' }`-sourced user message carrying a `<goal_complete>`/`<goal_blocked>` instruction to write a grounded closing message to the user and call no more tools. The turn then ends through the agent loop's ordinary no-tool-calls stop, so no new loop primitive exists and steering semantics are untouched. Direct-human mutations remain uninstructed exactly as before. The cost is one additional model request per goal lifecycle, not per round.

The instruction wording was selected by A/B sampling on `deepseek-v4-pro` with a reconstructed goal-round transcript: a structured instruction (outcome, verification, artifacts, next steps) consistently beat a minimal "summarize" one on completeness; adding a session-grounding clause shifted unsupported detail from asserted fact to hedged suggestion; and the no-instruction control produced high-variance closings, including confidently fabricated file-level detail.

Scripting the keyless proof required one snapshot-harness addition: `dsh-llm-replay` resolves `{{fromRequest:<regex>}}` placeholders in scripted entries against the live request, because a static sidecar cannot know the randomly minted goal id the model must echo into `update_goal`.

## Verification

`tool-goal` package tests pin the injected context (source, tag, objective, no-more-tools clause) and the absent `concludesTurn` for both terminal actions, plus the uninstructed direct-human pause and complete paths, at 100% file coverage. `llm-replay` unit tests pin the placeholder contract: last-match-wins capture, whole-match fallback, and loud failures for unmatched, invalid, and unterminated patterns. The new keyless ACP snapshot `goal-wrapup` drives the shipped application through create → round one → autonomous complete and asserts the plugin-sourced wrap-up injection, the same-turn closing assistant message, and the `completed` turn end in both the durable session log and the ACP stdout stream.

## Alternatives considered

- **Surface the completion text on the `update_goal` UI card** — rejected: `complete` carries no free text, and adding a `summary` argument would route a user-facing report through tool arguments while still cutting off the model's natural post-result message.
- **Keep `concludeTurn()` and add a "one more text-only step" loop primitive** — rejected: new `agent-loop` machinery for behavior the ordinary stop already provides once nothing concludes the turn.
- **Instruct inside the tool result content** — rejected: the goal tools' canonical output is compact JSON consumed programmatically; a prose instruction block inside it would mix the model-facing contract with the tool's replayable value.

## Consequences

Every autonomous goal ends with a user-facing closing message instead of a bare tool card, at the cost of one model request per goal lifecycle. `concludeTurn()` keeps its loop semantics but loses its only first-party caller outside subagent structured output. Snapshot scenarios can now script values that only exist at run time via `{{fromRequest:...}}`, which unblocks keyless coverage of any echo-an-id tool flow, goal or otherwise.
