---
description: "Webhook rule runtime for maintainers registering trusted external-event policies that create Workspace Sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-webhook

English | [中文](README.zh.md)

## Summary

`dsh-webhook` provides the Host `ctx.webhookRuntime`: a registry for trusted programmatic webhook rules plus the one built-in action, creating an ordinary root Session inside a Web Workspace. The interface stays at `register(rule)` and `dispatch(delivery)`; provider authentication belongs to adapter packages. Use it when a trusted rule must turn an external event into a new agent Session.

## Table of Contents

- [Rule interface](#rule-interface)
- [Session request](#session-request)
- [Composition](#composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="rule-interface"></a>
## Rule interface

`WebhookRule<K>` has a branded unique `id`, a provider `kind`, and `run(delivery, signal)`. A callback may execute arbitrary trusted code and returns either `null` or one `WebhookSessionRequest`. Rules of the same kind start independently, and one throw or rejection is logged without starving siblings.

`VerifiedWebhookDelivery` carries provider kind, configured source id, provider delivery id, normalized lossless JSON, and receipt time. The runtime snapshots and freezes the complete value before sharing it. `deliveryId` records the provider's identifier only; repeated delivery runs the rules again.

Registration is an effect. Its awaitable disposer first hides the rule, then aborts and drains active callbacks. Callbacks must observe the supplied signal; same-process code that ignores cancellation cannot be forcibly stopped safely.

<a id="session-request"></a>
## Session request

`WebhookSessionRequest` requires `workspacePath`, `title`, `prompt`, `agentPreset`, and `permissionPreset`; optional `model` names an explicit provider/model route plus an output-token cap. An explicit route uses its adapter's reasoning default. Omission snapshots the complete current deployment selection, including reasoning effort, until the first request records its durable header; later Web model changes retain the ordinary session behavior.

The runtime validates presets before mutation, resolves or creates the canonical Workspace, creates an Agent with that Workspace path as `SessionHeader.cwd`, mounts the agent preset before publication, and attaches the Session before applying permissions, title, and prompt. Failed attachment disposes the unpublished action. A later pre-prompt failure detaches the Workspace and disposes the Agent on a best-effort rollback.

Successful `Agent.followup()` is the webhook operation's commit point. The message uses `source.kind: "webhook"` and records the provider, source, delivery, and rule identifiers. The runtime does not wait for idle, flush specially, inspect the reply, or publish completion state; ordinary Agent and Session behavior owns everything afterward.

<a id="composition"></a>
## Composition

Load the runtime on the Web Host plane after Agents, model defaults, agent presets, permission presets, titles, and the Workspace registry. User-authored rule plugins inject `webhookRuntime` and yield the disposer returned by `register()` through their own effect.

The [GitHub review guide](../../../docs/user/guide/github-review.md) shows a rule module, dedicated ingress port, secret setup, and Workspace routing.

<a id="model-experience"></a>
## Model Experience

### Rule-authored initial prompt

#### What the model sees

For each matching rule, the model sees exactly the non-empty text returned as `WebhookSessionRequest.prompt`. The generic runtime adds no private framing; a rule incorporating external text owns its trust labeling. The shipped GitHub example labels selected PR fields as untrusted JSON metadata.

#### Token effect

One data-dependent user-role message is retained in the new Session and contributes tokens until ordinary compaction replaces or removes that history.

#### KV Cache effect

The initial prompt begins a new Session, so it establishes rather than invalidates that Session's reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Process-local fire-and-forget only** — a crash loses rule calls that have not admitted a prompt; there is no queue, replay, or retry.
- **No built-in deduplication** — repeated provider deliveries may create repeated Sessions; rules that need idempotency own it.
- **No completion result** — HTTP acceptance and rule settlement do not report Agent success, idle, or output.
- **Trusted callbacks must cooperate with cancellation** — runtime teardown aborts and awaits them but cannot terminate arbitrary same-process code.
- **Workspace creation may outlive a failed Session attempt** — an empty Workspace is retained because another concurrent caller may already use it.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
