# Agent Note: Timed user questions as two settlements

Status: proposed

English | [中文](2026-09-19-timed-user-question-two-settlements.zh.md)

## Problem

A question can block an agent even when useful work does not depend on the answer. Releasing the tool call after a wait must not discard the question: the user may answer after the agent has continued or after reopening the Session. A pending result is neither a skipped answer nor permission to proceed with work that requires approval.

The foreground tool result and the eventual answer have different lifetimes. A `user-questions/request` waterfall settles once; keeping it alive after returning pending creates a second answer path that outlives its caller. Countdown, focus, and editing also have different owners from durable question state.

## Proposal

Keep foreground answers on the existing Remote Event waterfall. A timeout ends that request and returns pending; a later answer uses a business RPC that steers a durable user message. The claim stream controls the foreground wait only. It neither transports answers nor replaces the Remote Event.

### Modes and scope

- The default `mode: legacy` retains the blocking schema and `ask()` path. Explicit `mode: timed` adds `timeout`, using the configured default of 120 seconds when omitted.
- A positive integer timeout selects `askTimed()`; `-1` selects blocking `ask()`. A blocking call made with the timed schema still participates in timed-question projection and review; it is not identical to a legacy call.
- Plan review retains `ask()`, its `plan-review` intent, and `BAD_INTENT` validation. This decision does not move plan review to another package.
- Human interaction requires the exact live runtime root when an Agent is supplied. A stale instance fails with `CALLER_NOT_LIVE`; an owned child fails with `DELEGATED_CALLER`. Durable Session lineage does not prevent a resumed runtime root from asking.

### Ownership

| Owner | Responsibility |
|---|---|
| `tool-ask-user` | Model schema, timeout validation, service selection, and pending-result text. |
| `UserQuestionService` | Foreground waits and Client claims, unattended deadlines, late-answer validation and steering, and the durable question projection. |
| Gateway and Remote runtime | Existing request delivery, settlement, cancellation, and Remote stream transport; no question-specific timer or event-name branch. |
| `ui-user-questions` | One card per Session and call, answer-channel selection, local countdown and drafts, and the reply Definition and renderer. |
| `ui-chat` | Message-id-based presentation aggregation and ordinary process/Turn folding. |
| Question-specific tool row | Pending/answered presentation and panel actions, composed in `QuestionToolRow` without adding `rowAction` to generic `ToolRow`. |

The [question service](../../../../packages/interaction/user-questions/README.md), [tool](../../../../packages/interaction/tool-ask-user/README.md), and [questions UI](../../../../packages/client/ui-user-questions/README.md) own their package contracts.

### Foreground wait and claim lifetime

`TimedQuestionWait` owns a private cancellation signal, the original Host deadline, and Client claims. The Host runs a timer only while no answer UI holds a claim. Delivery to a transport queue is not a claim. Losing the last claim restores the original deadline, with immediate expiry if it has passed.

A timed request carries `wait: { callId, timed: true }`. Before attaching its answer channel, the Client opens `attachWait`, a business Remote stream that yields one Host-computed `remainingMs` frame and stays open for the claim's lifetime. Focus, edits, and heartbeats do not travel through this stream.

The Client retains its claim through delivery of the waterfall outcome to the Host. Returning an answer locally is not delivery: releasing the claim then could let an overdue Host timer beat that answer. The Host closes the claim when the foreground request settles. Explicit delegation releases the claim before `next()`; plugin teardown delegates and cancels its stream.

Client countdown expiry rejects the waterfall with `ASK_TIMED_OUT`. Unattended Host expiry aborts only the private wait signal with the same business error. `askTimed()` maps only that error to pending, maps parent cancellation to `ASK_ABORTED`, and propagates other failures. `NO_PROVIDER` waits on the same bounded wait lifetime, not a permanently unresolved promise. Foreground completion releases timers, claims, and the wait registry entry.

### Durable state and late answers

The `userQuestions` projection reconstructs question state from existing Session events. It recognises the timed schema by the `timeout` parameter recorded in `request/header`; legacy calls are not tracked. A valid `tool/call` opens a question. Its `tool/result` makes it continued for pending or `TOOL_OUTCOME_UNKNOWN`, settles it with a valid answer batch, or removes it for another result or failure.

A continued question accepts `answer(agent, callId, answer)`. The method returns `false` for an unknown or non-continued call and throws `BAD_ANSWER` unless the batch names each question exactly once. Accepted answers use `agent.steer(createUserMessage(...))`, source `{ kind: 'user-question-reply', callId, outcome: 'answered' }`, and JSON text containing `answer_to_pending_question`, the call id, original questions, and answers. Remote Agent resolution from the Session id resumes a root when needed; the `answer()` body does not own that resume operation.

The inbox message is the durable reply. `agent/inbox/spliced` settles the question when the message is queued; the later admitted `user/message` is idempotent for that settlement. Settled answer batches remain in the projection so the original tool row can show late answers even though its own result remains pending. Unusable recorded reply text settles with an empty batch.

No new Session event type or wait-state log is needed. The message-source extension requires the repository's persistence-type acknowledgement. `dismissed` remains readable for historical records but has no producer: hiding a panel does not manufacture a reply.

### Card state and delivery races

`QuestionCards` shares one `PendingQuestion` between the live request and the continued projection, keyed by Session and `callId`. A blocking request without a call id has its own per-request card. An open card submits through its waterfall; without that channel it disables submission. A continued card uses the late-answer RPC.

A waterfall submission has no delivery acknowledgement. The Gateway can discard an outcome that loses a settlement race. The card therefore retains its draft and stays busy until projection reconciliation. If the question becomes continued during submission, the controls re-arm with a resubmit hint; the user can submit the retained draft through RPC. This is not automatic retry or a guarantee that every local submission reaches the model.

A tool-call-keyed card is removed when its call is absent from the active projection and no waterfall remains. Removal closes the card and clears its draft. Neither a local submission nor a transport cancel frame alone decides that the question is answered. An unkeyed blocking card ends with its waterfall; closing that blocking panel rejects with `ASK_CANCELLED`.

### Local countdown and panel actions

The Client computes `Date.now() + remainingMs`. Manual focus on a pristine answer surface pauses its countdown, and blur resumes the preserved remainder. Focus before the claim handshake remains effective when the deadline arrives; blur before the handshake does not create a timer. First edit or Take time freezes the countdown, with that disposition saved beside the browser-local draft.

Autofocus applies only when the answer channel is ready, no countdown is active, and the card is not locked. Hiding a timed-call panel leaves its claim and countdown running; its tool row can reopen it. A settled call opens a read-only panel from recorded questions and answers, not another answer channel.

### Reply node and grouping

The questions UI identifies a late reply from `source.kind`, then parses its recorded JSON for question-and-answer presentation. Pasting identical JSON in an ordinary user message does not identify it as a reply. Unreadable recorded payloads retain their raw-text presentation.

The ordinary message Definition and the question-reply Definition both match the appended message and retain separate Node Store projections with the same message id. Chat business grouping omits the `turn-trigger` presentation when a `question-reply` with that id is present. The duplicate trigger neither renders nor splits a group; the reply renders once. The same aggregation applies to unscoped historical input.

The reply participates in ordinary process grouping and whole-Turn folding. It is not independently visible: reading it can require expanding both its Turn and process group. Turn disclosure stays before the group it controls, including a reply that opens the Turn.

This decision adds no process-role field, independent-layout flag, user-message structure change, or target-local fallback dispatch. The independent-kind rules stay in Chat's existing grouping logic. A node-data-owned declaration of grouping and overlap semantics is deferred infrastructure, not part of the question feature.

## Alternatives considered

**Unconditional Host deadline or Gateway-owned question timers.** An unconditional deadline overrides local editing and Take time. Putting the exception into pending Remote Events or branching on the question event in Remote dispatch makes generic transport own business policy. Claims keep that policy in the question service.

**Keep the waterfall alive after returning pending.** The request outlives the tool caller, and late waterfall answers compete with the RPC. Ending the foreground request gives each settlement one answer path.

**Delegate every timed request immediately.** Dispatching to an intentionally empty answerer set wastes the existing blocking-answer path and requires special handling of `NO_PROVIDER`. Delegation is for an unavailable answerer, not the timed mode itself.

**Persist a whole-value wait/focus/edit stream or use Host focus leases.** Durable question status is derivable from tool and inbox events. Focus and editing are local UI state; logging them or synchronising focus leases adds Host state without making multiple Clients share one editing session.

**Reclassify JSON inside generic `MessageItem`, borrow the relay form, or use the default context row.** Parsing text to identify the business message confuses its source with its content; the relay form describes another agent's message, and a generic context row exposes JSON. A dedicated source, Definition, and renderer own the question presentation.

**Independent reply layout through generic node metadata.** It broadens a question feature into a conversation-infrastructure change. Ordinary folding and Chat-owned aggregation are sufficient for this decision; independently declared node-data grouping semantics remain a separate design task.

**A log-only close event or a manufactured dismissal message on panel close.** A log-only close hides the user's decision from the model and adds another durable mechanism. Manufacturing a reply treats hiding the panel as an answer. Panel close therefore leaves a timed question answerable.

**A dedicated late-reply Session event beside the inbox message.** The inbox splice and admitted user message already record the reply. A third event duplicates the same fact and adds another persistence type.

## Acceptance criteria

- Service tests cover claimed and unclaimed waits, last-claim disconnect, cancellation, timeout error mapping, continued-only answers, and exact answer-id validation.
- Projection tests distinguish legacy and timed schemas and cover pending, answered, other failures, resume repair, and duplicate inbox/message settlement.
- Client tests cover claim retention through Host acceptance, focus before handshake, indefinite waits, draft retention, RPC resubmission, and panel hiding/reopening.
- Grouping and browser replay cover one rendered reply with both projections retained, ordinary collapsed placement, disclosure ordering, and the original tool row's read-only late-answer panel.
- Legacy question round trips, cancellation, plan-review intent, and Session remounts retain their existing behavior. Live multi-Client delivery races and real Host restart remain integration coverage gaps beyond isolated lifecycle and projection tests.

## Risks

- Take time affects only one Client. Another Client can answer or expire the shared waterfall; local focus does not establish a global hold.
- A terminal claim-stream failure can reject the foreground question rather than produce pending. No unattended-wait fallback is provided for that failure.
- Host and Client clocks need not align, but Client system-clock changes can move expiry and transport latency can delay the local countdown's start.
- The duplicate projections remain stored. Aggregation adds linear scans during structural grouping rebuilds; ordinary text-only streaming updates retain their incremental path. This is an algorithmic bound, not a measured latency claim.
- Unanswered continued questions can remain after reopening a Session. Panel close records nothing, and visibility follows normal folding rather than an always-visible reply guarantee.
