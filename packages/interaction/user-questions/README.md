---
description: "Waterfall-based question and answer service for tools, permission plugins, local answerers, and Agent-scoped Web interactions."
kind: "package-reference"
---

# @deepseek-ai/dsh-user-questions

English | [中文](README.zh.md)

## Summary

Use `ctx.userQuestions` when a tool or permission flow needs a structured answer from the user. `ask()` waits for that answer; `askTimed()` may release the agent to continue independent work while the question remains answerable in the Session.

## Table of Contents

- [Ask a question](#service-userquestionservice-ctx-key-userquestions)
- [Role](#role)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service-userquestionservice-ctx-key-userquestions"></a>
## Ask a question

Call `ask()` when work cannot continue without the answer. Call `askTimed()` when the agent may continue independent work after a foreground wait. An answer UI claims that wait through `attachWait`, receives the Host-computed remaining duration, and counts down on its own clock. Without a claim, including after the last Client disconnects, the service releases the model at the original deadline. The `userQuestions` projection derives durable questions from the tool call, its result, and the eventual reply; Client claims are not persisted.

For a single-select question, `custom` overrides the selected choice and `selected` is empty. For a multi-select question, `custom` may supplement the labels in `selected`. A UI may preserve a skipped item as `{ id, selected: [] }`, keeping the existing answer shape while retaining other answers in the batch.

A question may carry a presentation `intent`, which declares that it IS a known kind of decision so a UI that recognises the tag may present it as such; the one tag is `plan-review`, whose `detail` is the plan under review and whose `approve` names the affirmative option. An intent changes presentation only: a UI honouring it answers with the same option labels a generic UI would send, and a UI that does not know the tag renders the generic option list. `ask()` rejects with `BAD_INTENT` the two assertions no type can carry: an `approve` naming none of that question's own options, and an intent on a question with no `detail`. `dsh-plan-mode` sets it on the `exit_plan_mode` review question.

When a request carries an agent, `ask()` authenticates its exact identity through the live `AgentRegistry` and admits only a runtime root. A live child cannot open a human interaction. An agentless programmatic request remains available to unscoped local waterfall listeners and fails with `NO_PROVIDER` when none accepts it.

While the tool call is open, the only answer path is that request; a browser that reconnects receives it again and can still complete it. Once the call has returned pending, or the process that owned it ended, the question is `continued`: the `answer` Remote method steers the reply into the agent as a `user-question-reply` message. No Remote method abandons a question — a Client that puts its panel away sends nothing, so the call stays answerable until an answer arrives. Answering a closed Session resumes its root agent first. Neither path fabricates a result for the finished tool call.

<a id="role"></a>
## Role

`UserQuestionService` owns each `TimedQuestionWait`, its cancellable Client claims, and its unattended timer. A claimed wait leaves countdown and focus/edit decisions to the Client. An unattended timeout aborts only the foreground request signal and returns pending, never aborting the Turn. The `userQuestions` projection records open, continued, and settled timed calls from existing Session events: native calls use the logged tool schema, while PTC sub-calls enter when their result is pending. The `answer` RPC validates one answer per question and accepts one queued reply per continued call; a second reply fails with `REPLY_QUEUED`. A discarded reply leaves the question answerable. A late batch stays in the projection because the original tool result contains the timeout, not that answer.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-ask-user`, which retains a successful answer as compact JSON or one of these failures: `Error: ask_user_question was aborted before the user answered`, `Error: ask_user_question requires at least one question`, `Error: human interaction requires the exact live calling agent when an agent is supplied`, `Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result`, `Error: no user-questions answerer accepted the request`, or `Error: <message>`. Waiting for the human adds no tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Agent-scoped Web answering** — Remote Events route the shipped Web answerer only when the request carries a live Agent scope; agentless callers need an unscoped local waterfall listener.
- **The vocabulary is the question-form shape only** — selectable options plus optional custom text; richer interaction shapes (file pickers, diff-preview confirmations) have no seam vocabulary yet.
- **Draft text is not part of Host question persistence** — the question survives restart across clients through the projection; unfinished input remains local to one browser profile.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** the `userQuestions` projection is derived from recorded tool calls, PTC dispatches, and admitted user messages; no separate question state is stored. A continued question can create a new user turn, but it cannot resume a finished tool call.
