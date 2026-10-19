# Agent Note: Keep Every Assistant Reply When a Turn Folds

Status: implemented

English | [中文](2026-10-15-chat-keep-assistant-replies.zh.md)

## Problem

In Compact, Standard, and Detailed, a normally completed Turn folds as a whole. Under the previous rule the reader saw only the input, the whole-Turn control, the **final answer**, and the footer. The final answer is chosen by position: the last Assistant message in the latest Step that has visible reply content and no tool-call block (`latestAnswer` in [turn-process.ts](../../../../packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts)). Every intermediate reply before it was hidden with the process.

Position is not content. A Turn often continues after the answer: a settled-subagent notice wakes another Step, the Agent updates its records, or it calls a tool after answering. The last message then becomes a short addendum, or there is no text-only ending at all, and the real answer folds into the process (#6132, #5429). For example, after a long research summary, a subagent completion notice woke one more Step whose message added a single remark; that remark was all the reader saw.

We made a rough estimate of how intermediate replies are distributed. The proportions below are order-of-magnitude judgments, not statistical results:

- In main Sessions, intermediate replies before the last reply make up about 10% of the Assistant text; subagent Sessions write more fragmented replies, about 20%.
- By count, more than half are one- or two-line "next I will…" messages, so showing all of them adds redundancy.
- A few longer intermediate replies carry actual conclusions or deliverables. Under the previous rule they folded with the process, which directly affected whether the reader understood the result.
- Some subagent tasks end with a structured-result tool call and no text-only reply, so under the previous rule the whole Turn showed no text at all.

## Decision

By default, a folded Turn hides only its process, never its replies: every `assistant-step` reply row stays outside whole-Turn folding, whichever Step it belongs to. Main and subagent Sessions use the same rule, without a branch on the Session kind.

Settings → General → Replies After Collapse sits directly below When to Collapse Work Details:

| Option | Behavior |
|---|---|
| All replies (default, `all`) | Every reply stays visible; only the process folds |
| Final answer only (`final`) | Previous rule: intermediate replies fold with the process and only the final answer stays visible |

- The choice is saved as `ui-chat.foldedReplies` in the same Host profile settings as Work details; without a saved value it uses `all` and does not write the default.
- Switching applies immediately to rendered Turns by changing visibility only, without rebuilding rows.
- Verbose never folds a Turn, so the option is hidden in that mode.

### What stays visible

| Viewing state (Compact/Standard/Detailed, `all`) | Visible content |
|---|---|
| Whole Turn collapsed | Input, whole-Turn control, **every reply row** in its original order, and Nodes at the `turn` position (terminal errors, max-token notices, the completed-turn footer) |
| Whole Turn open | Process group headers and every reply row; group bodies follow the mode and manual disclosure |

A collapsed Turn hides:

- the reasoning rows of every Step, including the final answer's reasoning;
- tool calls, their results, and step groups;
- Nodes at the `process` position, such as model retries;
- every other process row without a group-tree position.

A Turn with replies but no process content keeps the control's title without a collapse action.

### What does not change

| Aspect | Detail |
|---|---|
| Folding eligibility | Running, stopped, failed, and interleaved-input Turns offer no whole-Turn collapse; the rules for a missing start or end are unchanged |
| Whole-Turn control | One per Turn, with unchanged position and title (duration or status). Hidden step groups between replies simply disappear; no per-segment fold rows appear |
| Collapse timing | On completion, On next message, and the exchange exemption are unchanged |
| Manual disclosure | Still saved per answer generation |
| Footer, branch, and copy | Attached to the Turn's last settled Assistant message with text (`closing` of `turn-tail`), independent of whole-Turn folding |

### Implementation

Only the rule that decides process membership changes, and it follows the setting. `TurnProcessSpec` with its answer fields (`answerAnchorSeq`, `answerStep`, `inlineReasoning`, `messageCount`), the `latestAnswer` selection, and manual disclosure saved per answer Step stay as they were; with Final answer only they still apply and the behavior matches the previous rule.

| Location | Content |
|---|---|
| [chat-settings.ts](../../../../packages/client/ui-chat/src/chat-settings.ts), [index.ts](../../../../packages/client/ui-chat/src/index.ts) | `FOLDED_REPLIES_FIELD`, `FOLDED_REPLIES = ['all', 'final']`, and `DEFAULT_FOLDED_REPLIES = 'all'`, registered in `ChatSettingsFields` and the Host `Config` |
| [transcript-view.ts](../../../../packages/client/ui-chat/src/client/transcript-view.ts) | The `foldedReplies` snapshot and `setFoldedReplies` of `TranscriptViewPolicy`, read and written like `collapseTiming` |
| [presentation-policy.ts](../../../../packages/client/ui-chat/src/client/presentation-policy.ts) | `ChatPresentationPolicy.foldedReplies`; `presentationPolicyFor(mode, timing, replies)` returns one fixed object for each of the 16 combinations; `derivePresentationPolicy` subscribes to all three preferences |
| [apply.ts](../../../../packages/client/ui-chat/src/client/apply.ts), [settings/TranscriptViewRow.tsx](../../../../packages/client/ui-chat/src/client/settings/TranscriptViewRow.tsx), [locale.ts](../../../../packages/client/ui-chat/src/client/locale.ts) | The selector below collapse timing, not rendered in Verbose; Chinese and English copy |
| [chat/ChatNodeSeat.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx) | With `foldedReplies === 'all'`, a `replyRow` (the non-reasoning part of an `assistant-step` with reply content) is not a `processMember` and owns the disclosure (`ownsDisclosure`) to read `foldable`/`open`; collapsible content uses `hasNonReplyProcess` or `hasExternalProcess` according to the setting |
| [chat/AssistantNodeView.tsx](../../../../packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx) | With `all`, a folded Turn hides the inline reasoning of every reply row; with `final`, only the final answer's inline reasoning |
| [conversation-nodes/turn-process-presentation.ts](../../../../packages/client/ui-chat/src/client/conversation-nodes/turn-process-presentation.ts) | `hasNonReplyProcess` beside `hasExternalProcess`: an `assistant-step` from a Step other than the answer's counts as process content only through its reasoning |

The [Chat Node business rules](../../../../packages/client/ui-chat/src/client/conversation-nodes/README.md) describe the reader-visible rule and setting; [Chat group-tree positions and exchanges](../architecture/2026-10-11-chat-group-tree-exchanges.md) records that `assistant-step` reply rows stay outside whole-Turn folding.

## Alternatives considered

**Keep showing only the final answer.** The final answer is chosen by position. When a Turn continues after answering, the reader loses the real answer.

**Distinguish by message structure: show only replies without tool calls, except messages that call `present` or `ask_user_question`.** It removes part of the redundancy while keeping most of the effective content, but it needs a maintained list of tool-name exceptions, a fine-grained rule.

**Distinguish by a length threshold: keep folding short replies that precede a tool call.** It removes most short previews, but the threshold has no general basis, and Chinese and English character counts are not comparable.

**Keep the previous rule for subagent Sessions.** ui-chat would need to read `sessions.subagentAddress()` and branch on the Session kind. Subagent replies are more fragmented, so showing all of them adds more redundancy, but those views are rarely read directly, and a reader who opens one usually wants the process; subagent tasks that end with a structured result showed no text under the previous rule and now show the summary written before submitting the result.

**Give each process segment its own fold row.** Replies split the process into segments, adding many fold rows. The whole-Turn control already opens and closes the entire process at once.

**Also delete the final-answer structure (the `answerStep` fields, `latestAnswer`, and per-generation manual disclosure).** Less code, but a larger change, and Final answer only could no longer be offered.

**Change the default rule without a setting.** Readers who prefer the previous presentation would have no way back; the previous rule's code remains anyway, so a preference adds only one read/write path.

**Bind the option to the Work details mode (for example, Compact = final answer only).** No new settings row, but two independent choices would be tied together and could not be switched separately.

**Merge short action previews into the title of the following step group.** No text is lost and no row is added, but group titles need their own design, outside this change.

## Consequences

- Gains: Turns that receive a notice, record keeping, or a tool call after answering no longer lose the answer; subagent tasks that end with a structured result are no longer blank; readers who want the previous presentation can switch back with one choice.
- Collapsed text grows by an estimated 10% in main Sessions and 20% in subagent views. The added text includes actual conclusions that previously folded away as well as redundancy from one- or two-line action previews; subagent views are rarely read, so the absolute cost is small.
- After collapsing, consecutive replies no longer show the process between them and may read as one passage; each reply remains its own row with the original spacing.
- A collapsed Turn no longer gives its final answer the control's 16px clearance: in both choices, a reply separated from the control by folded rows keeps the 12px reply gap, and only a row directly following the control receives 16px. Because no reply changes its spacing when the fold finishes, the final answer no longer moves down about 4px at the end of a fold (#6323).
- The retained answer structure leaves one small asymmetry under `all`: `data-turn-process-messages` still counts the replies before the final answer although they are visible.
- These proportions are rough estimates and vary with ways of working and models.

## Testing

- `packages/client/ui-chat/tests/chat-view.client.spec.tsx`: replies from every Step stay visible while reasoning and tools fold, a Turn without a text-only ending still shows its replies, and a reply-only Turn offers no collapse; switching between `all` and `final` does not rebuild rows; cases that used an intermediate reply as a process stand-in now use reasoning-only rows.
- `packages/client/ui-chat/tests/presentation-policy.client.spec.tsx`: fixed policy objects for the 16 combinations and subscriptions to all three preferences.
- `packages/client/ui-chat/tests/transcript-view-policy.client.spec.ts`, `transcript-view-row.client.spec.tsx`, and `config.host.spec.ts`: default, persistence, and adoption; the settings row's position, Chinese and English copy, and hiding in Verbose; Host configuration validation and restoration.
- Web e2e: `turn-tail-actions.e2e.ts` and `chat-flow-layout.e2e.ts` assert that the first visible reply after a folded control keeps the 12px reply gap; the settings and folded-Turn aria goldens include the new settings row and intermediate replies.
