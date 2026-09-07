# Agent Note: Current sandbox policy context

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-current-sandbox-policy-context.zh.md)

## Problem

The sandbox policy already enforced and logged each session's file-effect mode, but a fresh model request did not contain that state. In a Web session under `read-only`, write and edit schemas remained visible, so the model claimed it could write and learned otherwise only after a denied call. After `/permission danger-full-access`, the next request carried the approval-policy change but still omitted the sandbox mode. Denial results were therefore the first model-visible policy source even when the user asked about capability before any operation.

## Decision

`dsh-sandbox-policy`, the owner of mode and workspace-root resolution, registers one `sandbox:policy` cache-safe context contribution. Every agent request resolves the active session directly through `ctx.sandboxPolicy.resolve({ session })`; there is no denial-history scan or process-local “last told” state.

The policy contribution is capability-neutral and available to every agent session by default. A composition may suppress the complete runtime-context channel when its model interface intentionally excludes dynamic context; this does not disable policy enforcement. The contribution does not maintain a second inventory of mounted backends or tools; model-visible schemas remain the authority for available operations, while the context conditions its claims on any available operation that the DSH file sandbox enforces. The [capability-neutral policy context decision](../simplification/2026-07-31-capability-neutral-sandbox-policy-context.md) supersedes the earlier family-registration mechanism while retaining this note's cache-safe delivery and durable snapshot design.

The contribution states only facts shared by every enforcement dialect. `read-only` says an available sandbox-enforced operation cannot modify files in the standing mode and directs the model to try an available tool normally, then follow any denial and escalation guidance that tool returns. `workspace-write` states the canonical session workspace with non-exclusive wording and summarizes, without enumerating, that some platform temporary areas may also be writable. `danger-full-access` says the DSH file sandbox does not restrict file modifications by available operations. Backend-selected temporary paths, `/dev/null`, runner readiness, exact tool availability, and other policy domains are absent because `resolve()` cannot establish them at request assembly.

The existing `dsh-system-prompt` assembly now has ordered dynamic contexts alongside stable system sections and tool schemas. After assembling one step, agent-loop renders all active contexts as one full snapshot with an explicit supersession statement. It appends a sourced `user/message` only when no retained snapshot exists, the bytes changed, compaction removed the retained message, or the final contribution disappeared and needs one clearing snapshot. The snapshot is appended after existing history and before `step/start`, so a changed policy preserves the preceding system-and-conversation cache prefix. The session event itself reconstructs the exact model input; `request/header` remains byte-identical when only policy context changes.

Ownership stays narrow. Approval policy contributes its complete current `ask` or `never` fact to the same full snapshot; migrating sandbox alone would not preserve cache because `/permission` changes both owners. Plan mode remains `plan:policy`, and tool plugins continue to own schemas plus attempt, denial, and escalation guidance. Context states standing policy; filesystem, one-shot bash, and terminal backends remain the enforcement boundaries.

The cache decision follows current source rather than analogy alone. Codex models permissions as a developer-role `WorldState` section with a persisted fingerprint, emits it only when state changes or retained history lost the fragment, and records the snapshot transition. Hermes keeps its system prompt fixed for a session and explicitly prepends changing skill, model, and voice notices to the next user message to avoid invalidating prompt cache. Pi has no comparable built-in sandbox state, and Claude Code's current native implementation is not publicly inspectable; Anthropic's public cache guidance nevertheless places changing per-request context after the stable cached prefix.

The earlier real-provider Web fixture quantified the defect in the system-section version. The first `danger-full-access` and `workspace-write` requests each reported only 256 cache-read tokens against 14,691 and 14,782 uncached input tokens. Later steps under an unchanged policy reported approximately 14.7k–15.5k cache-read tokens. Moving only the sandbox sentence would not fix those misses because the same preset switch also rewrote the approval-policy system section.

## Wording evidence

The wording experiment pre-registered preemptive refusal as its primary endpoint and required the old standing sentence to produce at least one refusal in twelve fresh sessions before any replacement could be judged. On 2026-07-30, commit `2bf41990401b194bd8637f07bbd90c67a9eeac75` ran `deepseek-v4-flash` through the shipped Web composition with the exact positive-control sentence `Bash commands run under the "read-only" file sandbox.` and the current tool-owned attempt guidance. The control produced zero preemptive refusals and zero speculative escalations; all twelve sessions made an ordinary bash call, observed a denial, escalated in the same turn, received approval, and landed the requested file. No sample was excluded.

After the cache-safe delivery change, commit `10d4e0ff7b68d38fc4403403b644aac442b97a00` repeated the same twelve-session positive control through the new tail-context channel. It again produced zero preemptive refusals and zero speculative escalations; all twelve sessions made an ordinary first call, observed denial, escalated in the same turn, and received approval. Eight landed the exact requested file, and no sample was excluded.

Both positive controls therefore failed the pre-registered sensitivity gate. The formal twelve-session Candidate A and B arms were not run, and these experiments do not select or validate the current wording. They establish that the earlier five-of-twelve result is not reproducible under this task and current tool guidance, and that a stronger positive control or different task distribution is required before making model-behavior rate claims. Deterministic tests below establish truthful request construction and replay only.

The cache-safe delivery rework then supplied a separate, non-statistical acceptance comparison over the neutral Web task `Create the relative path policy-neutral.txt ...`; it does not replace the pre-registered twelve-session experiment. Candidate A's categorical read-only statement produced a text refusal with zero tool calls. Candidate B added one composition-conditioned sentence only for enforced families whose tools expose escalation. A fresh real-provider run then issued an ordinary `write`, observed the read-only denial, retried the same operation in the same turn with `sandbox_permissions: "workspace-write"`, received approval, read the file back, and verified the exact contents. It made no speculative escalation. Across the permission switches and four mutation steps, cache reads were 14,848–15,872 tokens while uncached input was 59–306 tokens per request, directly demonstrating the stable-prefix benefit.

## Alternatives considered

**Narrate only mode changes.** Rejected because it leaves a fresh session uninformed and makes the first denied operation the policy-discovery mechanism. It also requires a baseline definition that is unnecessary when current state can be rendered directly.

**Scan denial history or remember the last narrated mode.** Rejected because denial events describe attempted operations, not authoritative current state, while process-local bookkeeping does not survive resume. The owner can fold the durable policy directly on every request.

**Put current policy in a dynamic system section.** Rejected after real provider evidence showed that a first-time permission switch reduced cache reads to 256 tokens while roughly 14.7k input tokens missed. DeepSeek matches complete prefixes; changing the first wire message prevents reuse of the longer system-plus-history prefix.

**Call `agent.inject()` independently from each policy owner.** Rejected because sibling listener order would define model order, separate messages could expose mismatched intermediate snapshots, and every owner would need its own compaction-retention scan. The existing assembly owner can order contributions and materialize one atomic full snapshot.

**A generic runtime-facts package.** Rejected because the existing system-prompt assembly already owns sections, schemas, variables, scope, and the authoritative per-step waterfall. Extending that owner with ordered contexts adds no package or second registry service.

**Repeat tool schemas or plan guidance in the context.** Rejected because those surfaces already have owners and independent lifecycles. Approval current state joins the snapshot only because the same `/permission` switch changes it and leaving its system section would retain the cache defect.

**Keep Candidate A after the cache-safe move.** Rejected by the neutral real-provider task: the model returned a pure text refusal and made no tool call despite the existing bash attempt guidance. The surviving anti-refusal principle states no escalation mechanics itself; it tells the model not to infer impossibility from the standing label, then delegates denial and escalation behavior back to the available tool.

**Keep sandbox mode absent because a standing mode label once caused preemptive refusal.** Rejected because a fresh Web request otherwise exposes mutation tools while withholding their standing policy, producing false capability claims before the first operation. The earlier live measurement remains a required counter-test: five of twelve turns ended without a tool call under `Bash commands run under the "read-only" file sandbox.` The committed tool-owned attempt guidance postdates that measurement, so the replacement is selected through a new positive-control experiment under the current tool contract rather than assuming the old and current conditions match.

**A separate model-context package.** Rejected because the policy owner can resolve current session state directly and the existing assembly service can order it. A new package would add a shallow composition layer and documentation/gate surface around the same request boundary.

**Enumerate writable temporary roots.** Rejected because the backend is selected later at `confine()`: bwrap, Landlock, Seatbelt, and the in-process filesystem fence do not grant one common temporary-path set. Host-specific paths in a standing request would be both unstable and overclaimed.

## Consequences

A model receives the standing file policy before probing a tool, and the next request after `/permission` reflects the committed mode. The stable system prompt no longer changes for sandbox or approval state; a changed full context snapshot is append-only after retained history, and unchanged state adds no message. Older snapshots remain in history but are explicitly superseded by the latest full snapshot. The statement is guidance, not an enforcement guard: runtime safety still comes from filesystem, one-shot bash, and terminal backends consuming the same resolved policy.

Focused tests pin all modes, canonical roots, switch timing, service disposal, context ordering, clearing, stable request headers, resume, and byte stability across different `TMPDIR` values. Keyless assembled snapshots pin the durable context message through real Loader compositions. Keyless replay owns the neutral denial-to-escalation trajectory; it is a structural regression proof, not wording-selection evidence.
