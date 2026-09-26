# Agent Note: Auto review asks the user after a denial

Status: implemented

English | [中文](2026-09-24-auto-review-user-approval-fallback.zh.md)

## Problem

[Auto review](2026-08-28-auto-review.md) made every reviewer denial final and reported every reviewer failure as that same denial. A person watching the Session had no way to let a denied call run, even when the reviewer misjudged an action the person wanted, so the only recovery was to switch the whole Session to Full access. A malformed reviewer response, a provider error, or a missing Session fact reached the model and the user as `Auto review rejected tool "<name>"`, so neither could tell a policy decision from a technical failure or act on the cause.

## Decision

A reviewer denial returns the tools pipeline's existing `ask` decision when the Session's approval policy is `ask`. `ToolRuntime` sends it through the approval service with the reason `Auto review denied tool "<name>"`, followed by `: <reviewer reason>` when the reviewer gave one. `allowed-once` executes the call; `rejected`, `cancelled`, and `unavailable` deny it through the approval service's ordinary messages, and the body does not run. The listener asks only after later `tools/pre-execute` listeners allow the call, so a downstream denial or cancellation wins without prompting.

Selecting Auto writes `danger-full-access` with the `ask` approval policy. A recorded Auto selection also matches the `never` policy. A [delegated in-process child pins `never`](2026-08-10-subagent-approval-pinned-never.md), so a child Auto keeps the final `AutoReviewDeniedError` denial and its reason, and a Session recorded under the earlier `never` bundle still resolves to Auto instead of Full access. Selecting Auto again writes `ask`.

A reviewer failure denies the call with `Auto review of tool "<name>" failed; its body was not executed: <error>` and no structured error info. A provider failure's message carries the finish kind, failure code, and provider message, so the model and the generic tool card show the actual cause.

## Alternatives considered

**Ask the user after every reviewer failure too.** A failure says nothing about the action's risk; asking would present a technical error as a policy question and would hide a broken reviewer route behind repeated prompts.

**Always return `ask` and let the `never` policy reject it.** The approval service reports that rejection as `the user rejected tool "<name>"`, which is false for a child, and it drops the reviewer's reason.

**Keep Auto on `never` and let the reviewer bypass the approval policy.** The approval service enforces `never` before any answerer so no listener can bypass it; the model-context policy text would also tell the main agent that no approval can happen.

## Consequences

- An interactive Auto Session can pause on an approval prompt, so Auto no longer guarantees unattended progress.
- The raw reviewer reason is visible to the user in the approval prompt and the approval audit events; the main model sees only the approval outcome.
- A reviewer failure's text, including provider messages, becomes model-visible tool error content.
- Switching between Auto and Full access now also changes the approval policy, so the live-agent switch path queues the approval-policy change notice.
- Unit tests cover the approval outcomes, the downstream-denial ordering, the child `never` path, and the specific failure messages; the shipped Web composition test covers a user rejection after a real reviewer denial.
