---
description: "Add experimental per-call Auto review to a Web or headless profile, using the current agent's model before tools execute with Full access."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-auto-review

English | [中文](README.zh.md)

## Summary

Add Auto review to a Web or headless profile. Web exposes it through the current-session permission pickers; headless selects it explicitly per invocation. Before each native or PTC inner tool call, the current agent's provider and model assess the pending action; an allowed call executes with Full access, and a denied call asks the user. The dsh installation ships this layer switched off; default Web keeps its three permission modes until it is switched on from the Web sidebar's Plugins page or installed explicitly. Auto review is experimental: it can allow unsafe actions, deny useful work, and spend additional tokens.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The review environment records the Session's current working directory for the pending action.

### Install into a profile

From this source checkout, install the package into the Web profile through the existing CLI:

```sh
pnpm dsh plugin --profile web add ./packages/experimental/auto-review
```

The CLI initializes the profile when needed and appends this package's declared patch after the base and Web layers. Reconciliation activates the patch as a profile layer; a package without `dsh.bundle.patch` is only an installed dependency. Select `Auto review` with its `EXP` badge in the composer menu or `/permission` picker and confirm the current-session risk dialog. An explicit `/permission auto` command switches directly. General settings and future-session defaults do not offer Auto.

Remove the layer through the same CLI:

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-auto-review
```

<a id="headless-supervision"></a>
### Headless supervision

Enable the experimental layer explicitly for the headless profile:

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-auto-review
dsh headless --permission-mode auto --approval-policy never --json - < task.txt > run.jsonl
```

For a one-off run from this checkout, pass `--patch /absolute/path/to/packages/experimental/auto-review/cordis.patch.yml` instead of installing a profile layer. An unavailable Auto integration fails preset selection before reading stdin or starting model work. Auto uses full host access; `--add-dir` is unnecessary in this mode. Native tools keep every tool body on the review path; direct Node effects in PTC remain outside it.

Auto treats text with `source.kind: 'user'` as `user-instruction`, regardless of transport or whether Auto was active when the message arrived. This includes existing user-sourced history, SDK/ACP callers, and plugins that submit as the user. A child's own creation prompt and direct-parent messages retain their subordinate instruction role; inherited and unverified creation prompts remain facts. Give the action, exact target, and scope explicitly. Project files, tool results, and checkpoints cannot authorize actions.

Select `--approval-policy never` after Auto selection so denials are final and retain `AUTO_REVIEW_DENIED` plus the optional raw reason in `tool_result.error`. `AUTO_REVIEW_FAILED` identifies invalid reviewer output or a technical failure. Neither executes the body. Review the task report even when `final.reason` is completed: the model can finish after a denied call.

Resume with the same worktree and `--session-id`. Omit both policy flags to retain saved policy, or pass both to select unattended Auto explicitly. A supervisor can send an explicit scoped instruction after a denial; a new call receives a fresh review. Headless has no channel for approving a pending call. `ask` uses any composed approval answerer and fails closed when none is available; it does not turn stdin into an approval channel. Application shutdown preserves Auto. The same integration must be loaded when restoring its Session, even to select another preset. Removing the plugin from a running application still migrates its live Auto Sessions to Full access.

### What you get

Auto reviews every supported call once before its body, including each started PTC `tools.*` inner call. It classifies actual effects: ordinary project-local work and exact cleanup of objects created in this Session are low risk and allowed; irreversible deletion of pre-existing objects, production operations, external writes, and security changes are medium risk and require explicit current user or direct-parent authorization of the action, target, and scope. Sensitive exfiltration across a trust boundary is high risk and always denied. Ambiguous effects and unresolved authorization conflicts are denied. Selecting Auto sets the `ask` approval policy, so a denied call asks the user and executes only after approval; a rejected or cancelled approval leaves its body unexecuted. A delegated in-process child pins the `never` policy, so its denials are final. Malformed reviewer responses and technical failures fail the call with their specific error and never execute it.

A final denial uses the ordinary tool card. The collapsed row identifies Auto review; expanded output states that the body did not execute and displays the optional reason. [The Web permission package](../../client/ui-permission-presets/README.md) owns picker interaction, and [the tool UI](../../client/ui-tool/README.md) owns reason display.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the package itself as the `auto-review` row. [`src/index.ts`](src/index.ts) requires the approval, LLM, permission, Session, and tools services, then installs the preset contribution and prepended pre-execute listener in one effect. After the review settles, a denial reads the Session's approval policy: under `never` it is final; under `ask` the listener delegates to later pre-execute listeners and returns the tools pipeline's `ask` decision only when they allow the call, so a later denial, cancellation, or `ask` (with its own reason) takes precedence. The `ask` decision carries an English audited reason and locale-owned English, Chinese, and Japanese prompt text from `src/locales.ts` that keeps the raw reviewer reason. The [permission owner](../../interaction/permission-presets/README.md) supplies the current identity and process catalog; Auto uses Full access's sandbox value with the `ask` approval policy and does not change tool definitions.

The reviewer sends the fixed policy as its system prompt, then one user message for the cwd-only environment, one per retained Session item in surface order, and the pending call last. Project instructions appear where they entered the surface, with the constraint role. A `tool-schema` item precedes the first call that used each reviewed schema; the integration remembers each reviewed call's schema for the live Session so that later reviews repeat it at the same position. Native schema comes from the latest request header. A PTC binding freezes its schema and carries it through the scheduler into transient execution metadata; start and settle events never serialize description or parameters. Main-agent `system/message` nodes, assistant text and reasoning, and tool results are excluded. The outer review input is a frozen `RequestUserInput` without durable identity or source; retained history keeps its original source attribution in the review text. [The decision record](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.md) owns authority, lifecycle, and child-inheritance rationale.

Unloading closes selection and review admission. If the application root remains active, unload then migrates live Auto Sessions to Full access through the existing preset writer; this includes plugin removal and reload. The migration writes the `never` approval policy without queuing a policy-change notice; the model sees the new policy in the next runtime-context snapshot. The sandbox value and persistent terminals survive the migration. Application shutdown preserves the selected preset and approval policy. Both paths abort and drain reviews before withdrawing the listener and contribution. A persisted Auto Session cannot publish without the complete integration, even when the reopening request selects another preset. Load the integration again before reopening. Reinstalling the layer restores the option but does not switch live Sessions back to Auto.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — publication policy and dependency isolation.
- [Web bundle](../../bundle/web-app/README.md) — the stable profile this patch extends.
- [Auto review decision](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.md) — fixed risk policy, authority, and lifecycle.
- [Tools](../../core/tools/README.md) — execution, cancellation, and PTC result propagation.

-----

<a id="model-experience"></a>
## Model Experience

### Per-call reviewer

#### What the model sees

The reviewer uses the latest `request/header.config` provider and model with the shipped adapter's default reasoning. Its fixed `REVIEW_POLICY` replaces human approval for exactly one action: allow executes immediately with Full access. The user messages contain only the retained facts described above. It returns one strict JSON text object with `risk` and `decision`; deny may include a string `reason`. Reasoning blocks may precede that single text block. Only `low + allow`, `medium + allow/deny`, and `high + deny` are valid.

#### Token effect

One additional model request per supported call, without caching, retries, truncation, compaction, or a separate small output budget. An oversized request fails the call with the provider error.

#### KV Cache effect

Each review's messages begin with all messages of the previous review, including its pending call, so routes that cache by prompt prefix, at message ends, or at a final marker with lookback reuse the policy and earlier history. Compaction, a cwd change, an earlier item leaving the surface, and the first review after a restart end that reuse once. Auto adds no dedicated runtime context or mode-switch prompt to the main agent. Each review request carries the reviewed Session's `sessionId` and `purpose: 'auto-review'` as model-hidden transport metadata. Routes that key prompt caching or request routing by Session, such as OpenAI `prompt_cache_key` and the `x-opencode-session` header that OpenCode requires, send reviews under that Session's key; [the DeepSeek Session-log upload](../../session/session-log-deepseek/README.md#request-field) contributes the canonical Session log when enabled and no registered exclusion matches.

### Tool denial

#### What the model sees

Under the `ask` approval policy, the model sees only the approval outcome, such as `the user rejected tool "<name>"`, or the approved call's ordinary result. A final denial message is `Auto review rejected tool "<name>"; its body was not executed`. A reviewer failure message is `Auto review of tool "<name>" failed; its body was not executed: <error>`. Ordinary native error rendering prefixes each message with `Error: `. PTC uses the existing inner-call exception and catch behavior; a caught denial does not force the outer `run_code` to fail. The raw optional reason is durable structured error detail for users, never main-model content. Risk, reviewer prompt, reasoning, and raw response are not persisted.

#### Token effect

A denied or failed call contributes only its ordinary error result to the main conversation.

#### KV Cache effect

The denial appends an ordinary tool result; it does not rewrite earlier context or hide existing model-visible information.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Auto requires this layer explicitly enabled. Default Web and Headless, General settings, and new-session defaults do not select it.
- Mods can submit user-sourced text. The [Claude Code mods bridge](../claude-code-mods/README.md#model-experience) gives both `$.prompt.submit` and `prompt.submit` hook context user authority, including framed submissions without `asUser: true`; text framing does not reduce that authority.
- Auto provides no file sandbox. The outer `run_code` transport and direct Node effects inside a PTC program do not pass through inner-tool review.
- Model classification can be wrong. There are no deterministic tool exemptions, persistent grants, configurable policy, or retry layer.
- In-process Auto children review their own calls. Out-of-process children retain their native permission systems after the parent delegation call is allowed.
- The reviewer reads the Session action history through the deprecated synchronous `snapshotEvents()` reader under a line-scoped waiver. Prior calls, PTC starts, and the direct parent's initial prompt have no projection or paged reader yet, so the migration stays deferred by [the synchronous-read decision](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
