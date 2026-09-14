# Agent Note: Experimental Auto review before each tool call

Status: implemented

English | [中文](2026-08-28-auto-review.zh.md)

## Problem

Full access lets useful project work proceed without repeated approvals, but it also permits destructive operations and sensitive exfiltration. A permission mode that delegates approval to a model needs an explicit authority policy, a complete description of the pending action, and a failure path that never executes the rejected body. Sharing Full access's enforcement knobs also makes a separate durable mode identity necessary, including when a child inherits an older fork prefix.

## Decision

[`dsh-experimental-auto-review`](../../../../packages/experimental/auto-review/README.md) is an explicitly installed experimental Web layer, published under the [experimental package publication decision](../process/2026-09-12-publish-all-experimental-packages.md). Default Web retains Read Only, Workspace Write, and Full access. The layer contributes current-session `auto`, whose only durable identity is `permission/preset:auto`; it shares Full access's unchanged `danger-full-access + never` knobs and tool definitions. Headless, General settings, and new-session defaults exclude the integration.

Every native call and started PTC `tools.*` inner call receives one review before its body. The outer `run_code` transport and direct Node effects in a PTC program remain outside this guarantee. There are no tool-name exemptions, cached grants, retries, configurable policy, second authorization check, or manual fallback. A repeated call receives a fresh review.

### Effects and authority

The fixed policy follows the allow/soft-deny/hard-deny distinction and classifies the action's actual effects, not its name or claimed intention:

| Risk | Examples | Decision |
| --- | --- | --- |
| `low` | Ordinary project-local reads/writes, analysis, format/lint/test/build, non-destructive Git, and exact cleanup of an object whose retained calls establish creation in this Session | Allow |
| `medium` | Irreversible deletion of pre-existing state, force push/history rewrite, production reads/writes/deployment, non-sensitive external writes/sends, and permission/security/system changes | Allow only with explicit current human or direct-parent authorization naming action, exact target, and necessary scope |
| `high` | Sensitive data exfiltration across the current trust boundary and equivalent hard-deny effects | Deny, including an explicitly requested action |

Actual effects that are ambiguous or broader than established scope fail closed. A later instruction clears an earlier conflict only by explicitly revoking or replacing it; direct-parent instructions cannot override human restrictions. History can establish a session-created object but cannot authorize medium work or remove a high-risk prohibition.

The reviewer derives authority from existing Session facts. A shipped Web human instruction has `source.kind === 'user'` and the `rpcId` written at browser prompt admission. A child's initial direct-parent prompt is identified after its own existing creation descriptor; a later `agent-message` is direct-parent instruction only when `senderSessionId` matches `SessionHeader.parentSession`. Human text defines or replaces the task and restrictions. Direct-parent text defines the child task within those restrictions. Project instructions only constrain; checkpoints restore lossy context; images, attachment metadata, and historical calls provide facts. Compaction does not promote a checkpoint into the human authority of text that left the surface.

### One complete reviewer request

The integration uses only the latest `request/header.config` provider/model and the shipped adapter's default reasoning. It neither compares redundant route metadata nor copies the main agent's request. The request has five fixed partitions:

| Partition | Retained input |
| --- | --- |
| `REVIEW_POLICY` | Fixed classification, source authority, and strict result rules; allow executes immediately with Full access and no later confirmation |
| `ENVIRONMENT` | Existing Session header `cwd` only |
| `PROJECT_INSTRUCTIONS` | Visible project instructions with their original sources and constraint role |
| `FILTERED_HISTORY` | Current compaction surface's sourced human/direct-parent messages, checkpoints, image/attachment facts, and historical call names with logged arguments |
| `PENDING_ACTION` | Tool name, description, parameter schema, and parsed arguments |

The reviewer builds those two action sections from the Session's complete action history: an authorization is the earlier call the `REVIEW_POLICY` source rules make eligible, and a duplicate or conflicting identity has to be visible anywhere in the log rather than inside a recent window, so neither the Session projections nor a bounded read serves the decision. The read is the deprecated synchronous `snapshotEvents()` under a line-scoped `typescript/no-deprecated` waiver.

The main agent's V3 `system/message` nodes, assistant text/reasoning, and tool results are excluded. The current call must belong to the open step recorded by `step/start`; missing step ownership fails closed. It appears only in `PENDING_ACTION`; an unstarted sibling has no historical call fact. Native schema comes from the latest request header. PTC captures a frozen schema at binding construction and passes it through the scheduler into `ToolExecution`; descriptions and parameter schemas never enter start/settle events or the Session/SDK wire. Missing, inconsistent, or ambiguous action facts reject the call without consulting the live registry. An oversized request fails closed without summarization, truncation, another compaction pass, or a small output-token budget.

### Result and cancellation

The reviewer may emit reasoning blocks followed by exactly one JSON text block and terminal `stop`. The closed object admits only `low + allow`, `medium + allow/deny`, and `high + deny`; only deny may carry a string `reason`. Extra fields, duplicate members, invalid combinations, other blocks or termination, and provider failures share the ordinary Auto denial outcome. Risk and reviewer traces are not durable state.

Native results and PTC settle events carry the same structured `AutoReviewDeniedError` / `AUTO_REVIEW_DENIED` and optional raw reason. The main agent receives only `Auto review rejected tool "<name>"; its body was not executed` through ordinary failure rendering. PTC retains the existing program exception/catch behavior; catching a denial does not elevate it to an outer failure. The generic Web tool card supplies the denial identity for the collapsed row and one not-executed output line for the expanded row, with no input body. Only that display trims and collapses line separators or supplies the localized empty-reason fallback; persistence and both SDKs preserve the complete raw reason, without a new length or redaction rule.

Admission and active-review enrollment occur synchronously before the first await. The integration owns one lifecycle controller and one set of active operations. Unload closes new selection/review admission, changes live Auto Sessions to Full access through the existing preset writer without changing knobs or closing terminals, then aborts and drains reviews before removing listener and contribution. After provider settlement, a lifecycle abort always produces canonical pre-dispatch cancellation, including late allow, deny, or failure. Caller cancellation retains ToolRuntime's priority: late allow cancels before dispatch; late deny or failure retains that outcome. No cancelled review starts a tool body.

A persisted Auto Session cannot publish when the complete integration is absent or failed. Its log is not rewritten, and no background retry runs. Reinstallation allows a user to reopen it; live Sessions migrated to Full access remain there until explicitly switched.

### Process catalog and children

The permission owner publishes one complete process catalog through generated `permissionPresets` Remote methods; the BFF explicitly mounts it and forwards a payload-free invalidation event. One browser directory subscribes before reading and serves both pickers. Epoch and connection-generation checks publish only the winning complete result. A winning failure or connection reset clears the previous snapshot; only a later existing read, notification, or reset retries. Disposed or stale settlements cannot publish. Each catalog invalidation dismisses the slash picker and its pending confirmation through the command owner while preserving the draft, so a picker waiting on its own read keeps its failure and retry state; reopening loads the current catalog. Session projection carries current selection only, so catalog installation or removal writes no Session event or sequence.

Auto appears with a superscript `EXP` badge. Both visible current-session pickers require the experimental confirmation; explicit `/permission auto` is already consent. The composer uses the generic Menu's existing portal placement to stay within the viewport while keeping its 218–360px bounds. The slash popup keeps `min(220px, 100%)` with `max-width: 100%`, including when a narrow composer collapses its trigger.

The [delegation-time policy capture](2026-07-25-subagent-policy-inheritance.md) records Auto or Full access before the first await and appends that existing preset event after fork seeding and sandbox/approval overrides. One-shot and continuable creation share the rule; cold resume reads only the child log. Later parent switches do not alter that child, while a later child switch can win. Read Only and Workspace Write retain sandbox inheritance plus `approval: never` and may therefore remain `custom`. Auto children classify each call independently using the existing lineage and messages, without parent call metadata, delegation records, receipts, Header/descriptor additions, or a Session-format change. Out-of-process children retain their own permission systems after the parent delegation is allowed.

## Alternatives considered

**Default or released integration** would make an experimental model approval policy part of every deployment. A private source Web patch keeps opt-in explicit while using the existing plugin installer.

**A new sandbox or approval-policy value** would couple review to enforcement and create combinations without a current consumer. An explicit preset identity preserves the unchanged Full access execution behavior.

**Persisting PTC schemas or rereading the registry** would either enlarge the durable wire for a transient input or review a different definition from the binding that the program received. The binding already owns the needed immutable snapshot.

**Session events for catalog changes** would assign process availability to a Session and require same-sequence republishing. A complete Remote read plus invalidation keeps each fact with its owner.

**Configurable policies, exemptions, grants, or another approval stage** would weaken the fixed safety ceiling or introduce a second decision lifetime. One review per supported call gives a single result and cancellation owner.

## Consequences

Auto adds model latency and token cost and can misclassify effects. Its full-access execution and PTC program limitation make the experimental confirmation necessary. Filtering limits untrusted instruction roles but does not make an LLM classifier a deterministic security boundary.

Focused owner tests pin request filtering, strict response parsing, denial propagation, catalog ordering, cancellation, and post-seed child identity. Real Web composition tests exercise default/experimental menus, confirmation, denial cards, live removal/reinstallation, persisted restoration, and terminal survival. The certification runner uses shipped tools on isolated targets and exactly eight real reviewer calls: Flash covers exact session-created cleanup, unauthorized/authorized pre-existing deletion, and explicitly requested synthetic exfiltration; Pro and Vision each repeat only the medium pair. It records redacted decisions and external effects without retries or skipped cases; deterministic tests provide the same policy cases without credentials.
