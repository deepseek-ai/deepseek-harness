# Agent Note: Headless caller authority for Auto review

Status: implemented

English | [中文](2026-10-18-headless-auto-review.zh.md)

## Problem

Headless, SDK, and ACP admit tasks with `source.kind: 'user'`. Auto must recognize those tasks as instructions without requiring a browser RPC identity. The message role alone is insufficient: injected context also uses the user role but names its own source.

## Decision

The [experimental Auto layer](../../../../packages/experimental/auto-review/README.md#headless-supervision) supports explicit headless selection. Default profiles remain unchanged. This extends the Web-only scope of [per-tool Auto review](2026-08-28-auto-review.md); its risk classes, full-access execution, PTC exclusions, and lifecycle remain authoritative.

The reviewer assigns user-sourced text the `user-instruction` role, including existing history and tasks admitted before Auto was selected. The user may be a human or a supervising caller. Both can define the task and authorize an exact medium-risk action, target, and scope. The current child's creation prompt and direct-parent messages keep their subordinate role; inherited and unverified creation prompts remain facts. Files, constraints, checkpoints, images, and tool results do not acquire instruction authority. Input producers own the source attribution; task text never selects its source. The message types and persisted fields remain unchanged.

Headless applies an explicit `--approval-policy` after selecting the permission preset. Saved policy continues when both options are omitted on resume. Pass `--permission-mode auto --approval-policy never` to select unattended Auto explicitly. This retains the structured denial and avoids dependence on a human answerer. `ask` still follows [the approval fallback decision](2026-09-24-auto-review-user-approval-fallback.md); it does not add a CLI approval transport. Application shutdown preserves the saved Auto selection. Restoring it requires the integration even when selecting another preset; removing the plugin while the application remains active still migrates live Sessions to Full access.

The JSON projection includes existing durable error fields under its normal output bounds. A final denial carries `AutoReviewDeniedError` / `AUTO_REVIEW_DENIED` and optional reviewer detail; a technical or parsing failure carries `AutoReviewFailedError` / `AUTO_REVIEW_FAILED`. Neither executes the tool body. Completed agent execution does not imply that every requested action succeeded.

## Alternatives considered

**Reuse a browser RPC id.** A headless invocation is not a browser request. Faking that identity would couple authorization to a different transport and misdescribe the persisted source.

**Add a headless admission marker.** The existing user source already identifies task input. A transport-specific marker adds persisted metadata and reader rules without changing the required authority decision.

**Promote every user-role message.** Plugins also supply user-role context. The existing source discriminator distinguishes admitted user input from injected content.

**A live caller-approval channel.** Headless consumes stdin as one task. Approving a suspended call needs a bidirectional protocol with correlation, disconnect and cancellation handling, and an answerer lifecycle. A later invocation can instead supply scoped authorization and receive a fresh review, without claiming to approve the earlier call.

## Consequences

A supervisor can use Auto for implementation and gates, inspect structured denials, and resume with revision instructions. Native tools keep all supported tool bodies under review; direct Node effects inside PTC remain outside it. The reviewer remains a fallible model with full-access consequences, and the integration remains experimental and opt-in. Custom producers that use the user source are treated as the user; background context must use its own source.
