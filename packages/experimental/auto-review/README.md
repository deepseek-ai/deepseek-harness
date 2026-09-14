---
description: "Add experimental per-call Auto review to a Web profile, using the current agent's model before tools execute with Full access."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-auto-review

English | [中文](README.zh.md)

## Summary

Add Auto review to the current-session permission pickers in a Web profile. Before each native or PTC inner tool call, the current agent's provider and model assess the pending action; an allowed call executes with Full access. Default Web keeps its three permission modes until this layer is explicitly installed. Auto review is experimental: it can allow unsafe actions, deny useful work, and spend additional tokens.

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

### Install into a profile

From this source checkout, install the package into the Web profile through the existing CLI:

```sh
pnpm dsh plugin --profile web add ./packages/experimental/auto-review
```

The CLI initializes the profile when needed and appends this package's declared patch after the base and Web layers. Reconciliation activates the patch as a profile layer; a package without `dsh.bundle.patch` is only an installed dependency. Select `Auto review` with its superscript `EXP` badge in the composer or `/permission` picker and confirm the current-session risk dialog. An explicit `/permission auto` command switches directly. General settings and future-session defaults do not offer Auto.

Remove the layer through the same CLI:

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-auto-review
```

### What you get

Auto reviews every supported call once before its body, including each started PTC `tools.*` inner call. It classifies actual effects: ordinary project-local work and exact cleanup of objects created in this Session are low risk and allowed; irreversible deletion of pre-existing objects, production operations, external writes, and security changes are medium risk and require explicit current human or direct-parent authorization of the action, target, and scope. Sensitive exfiltration across a trust boundary is high risk and always denied. Ambiguous effects, unresolved authorization conflicts, malformed responses, and technical failures fail closed.

A denied call uses the ordinary tool card. The collapsed row identifies Auto review; expanded output states that the body did not execute and displays the optional reason. [The Web permission package](../../client/ui-permission-presets/README.md) owns picker interaction, and [the tool UI](../../client/ui-tool/README.md) owns reason display.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the package itself as the `auto-review` row. [`src/index.ts`](src/index.ts) requires the LLM, permission, Session, and tools services, then installs the preset contribution and prepended pre-execute listener in one effect. The [permission owner](../../interaction/permission-presets/README.md) supplies the current identity and process catalog; Auto shares Full access's existing sandbox and approval values without changing tool definitions.

The reviewer reconstructs five sections from the current Session surface and pending execution: fixed policy, cwd-only environment, sourced project constraints, filtered sourced history, and the complete pending action. Native schema comes from the latest request header. A PTC binding freezes its schema and carries it through the scheduler into transient execution metadata; start and settle events never serialize description or parameters. Main-agent `system/message` nodes, assistant text and reasoning, and tool results are excluded. [The decision record](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.md) owns authority, lifecycle, and child-inheritance rationale.

Unloading closes selection and review admission, migrates live Auto Sessions to Full access through the existing preset writer, then aborts and drains reviews before withdrawing the listener and contribution. Knobs and persistent terminals survive that migration. A persisted Auto Session cannot publish without the complete integration; reopening it after installation is an explicit user action. Reinstalling the layer restores the option but does not switch live Sessions back to Auto.

No runtime invariant companion is published: this single effect owns selection admission, review enrollment, cancellation, and cleanup; it has no independent observation that can diverge from those owned operations.

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

The reviewer uses the latest `request/header.config` provider and model with the shipped adapter's default reasoning. Its fixed `REVIEW_POLICY` replaces human approval for exactly one action: allow executes immediately with Full access. The other four sections contain only the retained facts described above. It returns one strict JSON text object with `risk` and `decision`; deny may include a string `reason`. Reasoning blocks may precede that single text block. Only `low + allow`, `medium + allow/deny`, and `high + deny` are valid.

#### Token effect

One additional model request per supported call, without caching, retries, truncation, compaction, or a separate small output budget. An oversized request fails closed.

#### KV Cache effect

The fixed reviewer policy can share a prefix; retained history and the pending action vary per call. Auto adds no dedicated runtime context or mode-switch prompt to the main agent.

### Tool denial

#### What the model sees

The denial message is `Auto review rejected tool "<name>"; its body was not executed`. Ordinary native error rendering prefixes it with `Error: `. PTC uses the existing inner-call exception and catch behavior; a caught denial does not force the outer `run_code` to fail. The raw optional reason is durable structured error detail for users, never main-model content. Risk, reviewer prompt, reasoning, and raw response are not persisted.

#### Token effect

A denied call contributes only the ordinary fixed error result to the main conversation.

#### KV Cache effect

The denial appends an ordinary tool result; it does not rewrite earlier context or hide existing model-visible information.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Auto requires an explicitly installed Web layer; it is absent from default Web, Headless, General settings, and new-session defaults.
- Auto provides no file sandbox. The outer `run_code` transport and direct Node effects inside a PTC program do not pass through inner-tool review.
- Model classification can be wrong. There are no deterministic tool exemptions, persistent grants, manual fallback, configurable policy, or retry layer.
- In-process Auto children review their own calls. Out-of-process children retain their native permission systems after the parent delegation call is allowed.
- The reviewer reads the Session action history through the deprecated synchronous `snapshotEvents()` reader under a line-scoped waiver. Prior calls, PTC starts, and the direct parent's initial prompt have no projection or paged reader yet, so the migration stays deferred by [the synchronous-read decision](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
