# Agent Note: Subagent end-turn guidance stays in the delegation paragraph

Status: implemented

English | [中文](2026-10-21-subagent-end-turn-guidance.zh.md)

## Problem

The delegation guidance paragraph ended with `When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.` A later prompt revert removed that sentence together with unrelated prompt changes.

Before the sentence existed, one long Session slept seven times for 150–240 seconds each (about 25 minutes) waiting for review subagents that finished in 2–9 minutes (#6057). A controlled probe on 2026-10-21 measured the sentence's effect on the model's next message after a child starts: `deepseek-v4-flash` and `deepseek-v4-pro`, 150 requests per arm per model, minimal system prompt, real `subagent` and `bash` schemas, history ending with `started subagent reviewer-1`.

| Arm | Sleep call | Any bash call | Ended turn |
|---|---|---|---|
| With the sentence | 0/300 | 7/300 | 291/300 |
| Without the sentence | 29/300 | 120/300 | 179/300 |

The per-model difference is `0/150` vs `6/150` for flash (p=0.030) and `0/150` vs `23/150` for pro (p=9.6e-8), two-sided Fisher exact. The two remaining samples in the with-sentence arm called `subagent` again instead of ending the turn.

## Decision

The delegation paragraph keeps the end-turn sentence, byte-identical to the text introduced for #6057. Ending the turn does not lose the result: a settled child delivers a user-role notice to its parent, and a notice that reaches an idle parent starts one independent model request ([`dsh-subagent`](../../../../packages/subagent/subagent/README.md)). Hosts that keep children progressing alternate `agent.whenIdle()` and `waitForChildren(agent)` ([ACP `session.ts`](../../../../packages/acp/acp/src/session.ts)), and `dsh-goal-round-driver` waits for running descendants before starting the next goal round.

The sentence stays one literal line. Rewording `the next result starts a new turn` to `each result starts a new turn` would re-render 83 prompt sidecars without a measured behavior change.

## Alternatives considered

**Rely on the tool description.** The `subagent` tool description states that the runtime notifies the model when the child finishes. The probe measured 29/300 sleep calls without the paragraph sentence, so the tool description does not replace it.

**Move the guidance into the tool description.** The paragraph is assembled from the set of visible delegation tools and lists their names; the tool description describes one tool. Moving the sentence changes ownership without changing the behavior it prevents.

**Restore every prompt phrase reverted together with this sentence.** The read guidance and the `run_code` argument order are separate decisions with their own evidence; this note records only the delegation paragraph.

## Verification

- `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` asserts the rendered paragraph for each visible-tool combination, including the restored sentence (9 expectations).
- 83 `snapshots/**/system-prompt*.expected.md` sidecars carry the restored text and replay through the shipped headless profile in `test:snapshot`.
- The probe is a one-off controlled measurement and is not committed; its two arms differ only in the guidance sentence.

## Consequences

- Every request with a visible delegation tool carries one more sentence, about 30 tokens.
- The model ends its turn while only waiting for a delegated result instead of calling `bash sleep` or polling.
- A future prompt-slimming pass must treat this sentence as load-bearing; the probe table above is the evidence for keeping it.
