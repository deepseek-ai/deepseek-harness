# Agent Note: The approval seam — one-shot permission decisions over a waterfall of answerers

Status: implemented

English | [中文](2026-07-06-approval-seam.zh.md)

## Problem

Two callers need one closed decision — "may this specific action proceed?": `tools/pre-execute`'s `ask` decision (including the Claude-Code hook bridge's `permissionDecision: ask`) and the [sandbox Agent Note](2026-07-06-sandbox.md)'s post-denial one-shot escalation retry. A shared seam keeps them from inventing separate outcome vocabularies, channel routing, cancellation, and audit trails, while guaranteeing that a deployment with no answerer can never grant an unanswerable request. The answerer may be an interactive host or an automated controller.

The routing problem is ownership: a permission request must reach the channel that owns the asking agent, fail closed for agents nobody owns, and stay out of deployments that compose no answerer.

## Decision

One package, `dsh-user-approval` (`packages/interaction/user-approval`), owns the vocabulary and the `ctx.approval` service — the mechanism. The policy — who answers, and whether a session is asked at all — lives outside it: answerers are `approval/request` waterfall listeners registered by channel-owning plugins (the ACP bridge, host adapters, and test scripts), and a per-session policy tier can decide before a channel is involved. Consumers (`dsh-tools`' ask routing and the sandbox escalation gate) resolve a question to a closed outcome and derive their own tool results from it. This is deliberately one package, not the capability-seam three (see Alternatives).

### How a deployment uses it

One `cordis.yml` entry mounts the seam. Not loading it is the fail-closed opt-out: consumers deny unanswerable requests with zero approval code registered.

```yaml
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  # config:
  #   policy: never   # deployment default for sessions without an override; 'ask' when omitted
```

The entry alone provides mechanism, not a channel: with no answerer composed, every ask resolves `unavailable` and the asking tool call denies — fail-closed needs no configuration. Composing the [ACP profile app](../../../../packages/bundle/acp-app/README.md) completes the loop: its [automation-only bridge](../simplification/2026-07-23-acp-automation-only-protocol.md) registers an answerer that sends `session/request_permission` to the owning client with the exact tool-call id and one-shot allow/reject options. `policy: never` is the unattended stance — every ask auto-rejects deterministically, and the current value joins the runtime-context snapshot. `policy` is validated against the closed list at plugin load; anything else throws.

What a composed deployment observes: `allowed-once` lets exactly that call proceed; rejection, dismissal, and channel absence deny with three distinct reasons the model can tell apart; a successful in-turn request lands a durable `approval/asked`/`approval/decided` pair on the asking agent's session log; nothing about a grant persists past the call that asked. An idle request or audit append failure rejects instead of returning an unaudited decision.

One ask under this composition, from the sandbox example's recorded `escalation-approved` scenario — the model requests a sandbox escalation, the gate asks, and the automation client selects Allow once:

```
tool/call        bash {"command": "printf 'escalated\n' > escalated.txt && cat escalated.txt",
                       "sandbox_permissions": "workspace-write",
                       "justification": "the user asked to write escalated.txt in the workspace"}
approval/asked   {"toolName": "bash", "callId": "call_00_…",
                  "reason": "escalate sandbox to workspace-write: the user asked to write escalated.txt in the workspace"}
  → session/request_permission {"toolCall": {"toolCallId": "call_00_…"},
                  "options": [{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                              {"optionId": "reject-once", "name": "Reject",     "kind": "reject_once"}]}
  ← the client selects "Allow once"
approval/decided {"outcome": "allowed-once"}
tool/result      "escalated" — this one call ran under the wider mode; the grant died with it
```

The `escalation-rejected` twin ends in `{"outcome": "rejected"}` instead: nothing executes, and the model's result carries the asker's verbatim fail-closed text (`the user rejected escalating this command to "workspace-write"`). A hook's `permissionDecision: ask` rides the identical wire; only the asker and its deny texts differ (§ Ask routing in dsh-tools). Without an answerer, the same request settles `unavailable`.

### Design detail

#### The seam: mechanism and policy split

After validation and a successful `approval/asked` append, the service resolves the `approval/request` waterfall to `allowed-once`, `rejected`, `cancelled`, or `unavailable`. It borrows the readonly request identity and signal, treats abort as `cancelled`, contains answerer failures and invalid returns as `unavailable`, discards late answers, and appends the paired `approval/decided` event. Pre-commit audit failures reject; post-append observer failures cannot undo an authoritative event. `allowed-once` authorizes only the asked action, and `request()` rejects outside an open turn so the audit pair remains inside the durable commit boundary.

Answerers are `approval/request` waterfall listeners. Zero listeners fall through to `unavailable`; a recognizing listener occupies the first-wins decision slot, while an unrecognized agent must delegate with `next()`. Listeners dispose with their fibers, so an unloaded channel fails closed. Because sibling registration order is not deterministic, a deployment composes one terminal answerer and reserves `prepend` for decide-or-delegate gates.

`ApprovalRequest` carries the asking `agent`, `toolName`, optional exact `callId`, human-readable `reason`, and optional `signal`. It uses the `ToolCallId` brand without importing `dsh-tools`, which depends on this seam. Channel adapters correlate any richer call state by `callId`; the approval request does not duplicate tool arguments.

#### Ask routing in dsh-tools

`ToolRuntime.execute()` resolves `ask` before dispatch: `allowed-once` proceeds, while rejection, cancellation, and channel absence produce distinct deny reasons. Opportunistic `ctx.get('approval')` consumption lets an absent or unmounted service fail closed without gating the registry fiber. Agent-less execution also fails closed because it has neither an audit session nor a channel owner.

#### The per-session policy tier

The seam also owns the session-scoped `'ask' | 'never'` policy described by [the sandbox Agent Note](2026-07-06-sandbox.md). Effective policy is folded from logged switches over the deployment default. `'never'` resolves to `rejected` inside `request()` before any answerer can run; `'ask'` dispatches and otherwise falls through to `unavailable`. Both current values join the atomic runtime-context snapshot before each model request, so a policy switch needs no separate narration; every approval request still records the audit pair.

#### The ACP answerer

The ACP bridge answers only for an exact agent object owned by its session map. It sends `session/request_permission` with the existing `callId`, advertises one-shot allow/reject options, maps cancellation separately, and never grants an unknown option. Foreign or call-less requests delegate; a failed client RPC becomes `unavailable`. Hooks and `tools/pre-execute` decide whether a call asks at all. This channel is machine policy between an automated client and its agent, not ACP presentation.

The answerer routes through the bridge's exact-agent ownership check described by [the automation-only ACP Agent Note](../simplification/2026-07-23-acp-automation-only-protocol.md), preserving the per-session permission ownership required by [the multi-session Agent Note](../../archived/feature/2026-06-14-acp-multi-session.md).

#### Audit, and what the model sees

`approval/asked` and `approval/decided` are durable log-only events; the model sees only the ordinary tool result derived from the outcome. Successful completion commits one `decided` per `asked`, including cancellation and contained answerer failure. Idle requests append neither event; a pre-commit failure rejects, while failure of the second append can leave an already-committed `asked` unmatched.

#### Entities and dependencies

`dsh-user-approval` depends on Cordis plus the session, agent, and branded-call contracts; `dsh-tools` and `dsh-acp` consume it. The sandbox executor stays independent because `dsh-tool-bash` owns escalation requests. The fixed dispatch-and-audit service remains one package; replaceable answerers live with their channel owners. Static capability grants and `subagent-acp` child-side permission answers remain separate concerns.

### Testing

Unit tests pin outcomes, first-wins delegation, containment, cancellation, scoped routing, audit pairing, the unbypassable `'never'` policy, tool deny reasons, and ACP ownership/outcome mapping through a real scripted bridge.

Snapshots record allowed and rejected sandbox escalation through `session/request_permission`, plus the complete `'ask'` and `'never'` runtime-context contributions. Unscripted permission prompts cancel and fail closed.

## Deferred

- **`allow_always` grant storage** — honoring a persistent grant means designing storage, scope identity (call? path? prefix? session? time window?), and revocation; until designed, only the one-shot options are advertised ([the sandbox Agent Note](2026-07-06-sandbox.md) § Escalation records the open scope question).
- **A recorded hook-driven `ask` through a composed answerer** — the permission wire is recorded through the sandbox example's escalation branches. The hook matrix's `hook-cc-pretool-ask` pins the no-ApprovalService fallback denial, while the hook-producer-plus-answerer composition remains on the unit tier.
- **Routing a child agent's approvals to the parent session** — `subagent-acp`'s child auto-answers its own permission requests; delegating them to the parent controller is its own design.

## Alternatives considered

- **A single registered provider instead of waterfall listeners** — rejected: a `registerProvider()` API forces every composition question — allowlist pre-filters, external hook deciders, scripted test answers, a policy gate in front of a human — inside one provider implementation. The waterfall gets composition, fail-closed absence, and HMR disposal from machinery the runtime already has; the seam's JSDoc pins the single-decision-slot convention instead of inventing a provider registry.
- **An inline `tools/pre-execute` permission gate in the ACP bridge** — rejected: prompting for every bridge-owned call hardwires the asking policy into the transport, cannot serve a second asker (sandbox escalation happens after execution starts, with no pre-execute moment), and leaves hook-produced `ask` decisions without a shared mechanism.
- **The generic user-questions seam (`ctx.userQuestions`)** — rejected as the approval mechanism: the two share a skeleton (route by agent, block for a human, handle absence), but approval's contract is narrower in every dimension that matters: a closed outcome vocabulary instead of free text, a protocol-native prompt attached to a tool call instead of a generic form, mandatory fail-closed absence, and audit events. Approval therefore does not ride the shipped `packages/interaction/user-questions` / `ask_user_question` elicitation path — an elicitation form is not a permission prompt, and a free-text answer is not a closed outcome; sharing provider plumbing stays open if the two ever converge.
- **Static optional injection in `dsh-tools`** — rejected: the vendored cordis `Inject` type has no optional flag — the object form maps service names to intercept config, and a declared inject gates the fiber. `ctx.get('approval')` is the documented opportunistic-consumption pattern (the `tool-bash` owner-token lookup, the loop's persistence probe), reads presence per call, and degrades correctly across HMR without extra machinery.
- **The capability-seam three-package split** — rejected: Service Definition / Service Provider / Consumer fits a seam whose Service Provider is swappable (bash-local vs bash-sandbox). Here the service body is fixed mechanism and the variable part is listeners that live with their owners — splitting would manufacture a Service Provider package with nothing in it ("don't split preemptively").
- **Offering `allow_always` now** — rejected: the protocol can express it, but honoring it means designing grant storage, scope identity, and revocation (§ Deferred). Advertising an option the harness cannot honor manufactures doomed grants.

## Consequences

The implemented contract is pinned by the suites in Testing:

- `allowed-once` dispatches one action; every other outcome denies with a distinct reason, and `'never'` rejects before prompting.
- Missing, foreign, agent-less, throwing, invalid, and disconnected answer paths fail closed.
- Successful requests route by exact agent ownership and append one replayable, model-invisible audit pair; idle and pre-commit failures reject.
- ACP ownership keeps decisions inside their session, while a deployment without the service emits no request or audit events.

Costs and accepted limits:

- **Two decide-eager answerers race for the slot.** Sibling-plugin listener order is not deterministic, so the seam cannot referee competing terminal answerers — mitigated by convention (one terminal answerer per deployment; `prepend` only for decide-or-delegate gates) rather than a priority mechanism the event bus does not have.
- **Production exercise rests on one composition.** `ask` has two producer families — the hook bridges through `tools/pre-execute`, and sandbox escalation through its own gate — with the wire recorded in the sandbox example's snapshot suite, so the seam's real-world coverage is that one composition until more deployments compose it.
- **Ownership keys on `Agent` object identity.** The answerer resolves the session-map record at `agent.session.id`, then requires that record to own the exact agent object; every current path hands the same object through the loop and the seams, but a future boundary that clones or proxies agents would make the bridge delegate and fail closed, and would need a different ownership contract.

## FAQ

- **What happens in a deployment with no answerer at all (headless, CI)?** Every ask falls through the empty waterfall to `unavailable` and the tool call denies with the "no approval channel is available" reason. Fail-closed is the zero-listener default, not a configuration.
- **Can a grant persist — "always allow this"?** No. `allowed-once` authorizes the single asked-about action and the service stores nothing between requests; `allow_always` is deliberately not advertised until grant storage is designed (§ Deferred).
- **What does the model see of an approval?** Only the tool result the asker derives from the outcome — the audit pair never enters the transcript. The three non-grant reasons are distinct, so the model can tell a human "no" from a dismissed prompt from a missing channel.
- **Who decides whether a call asks in the first place?** Policy producers: a hook returning `permissionDecision: ask`, any `tools/pre-execute` listener, or the sandbox escalation gate. The seam and the bridge only route and answer; neither injects its own judgment about what deserves a prompt.
- **What happens when the user dismisses the prompt, or the turn aborts mid-ask?** Dismissal maps to `cancelled` with its own deny text. An already-aborted signal settles `cancelled` without dispatching; an abort during the ask discards the late answer. When both audit appends commit, either path records one pair, never two.
- **What if the client answers with an option the harness never offered?** Any selection other than the offered `allow_once` maps to `rejected` — an unknown optionId from a non-conforming client can never grant.
- **How do subagents' approvals route?** They do not: delegation pins every in-process child to `'never'` ([approvals-pinned decision](2026-08-10-subagent-approval-pinned-never.md)), so each child ask resolves `rejected` before any answerer and the child is told up front through its runtime context. `subagent-acp`'s child-side auto-answer is separate; routing a child's asks to the parent controller is deferred (§ Deferred).
- **What does `policy: 'never'` actually change at runtime?** The service resolves every ask for that session to `rejected` before dispatching any answerer (in-service, so no registration order can bypass it); the next atomic runtime-context snapshot states the policy; each successful auto-rejection records the audit pair.
- **What happens across a hot reload, or when an answerer unloads mid-session?** Answerers dispose with their owning fiber, so the next ask degrades to `unavailable` instead of hanging on a dead channel; remounting re-registers the answerer with no catch-up state.
- **Where does a client get approval context?** The request carries the exact `callId` and the asker's human-readable `reason`; channel adapters may correlate richer tool-call state without duplicating arguments in the approval seam.

## Prior art

In-repo precedents this design copies or contrasts with:

- The `fs/write-intent` gate (`packages/fs/fs/`) — the documented single-occupancy decision-slot waterfall semantics (first answer wins, delegate via `next()`) the answerer contract reuses.
- `hook/invoked`/`hook/result` — the log-only audit-pair precedent `approval/asked`/`approval/decided` follows; [the hook-bridges Agent Note](../../archived/feature/2026-06-30-hook-bridges.md) ships `permissionDecision: ask`, the first producer.
- [The interception extension-points Agent Note](2026-06-30-interception-extension-points.md) — the `tools/pre-execute` `allow`/`deny`/`ask` vocabulary whose `ask` this seam services.
- [The automation-only ACP Agent Note](../simplification/2026-07-23-acp-automation-only-protocol.md) — the exact-agent ownership check against the session map that the answerer routes through; [the multi-session Agent Note](../../archived/feature/2026-06-14-acp-multi-session.md) — the per-session permission-ownership blocker this implements.
- The opportunistic `ctx.get()` consumption pattern (`tool-bash`'s owner-token lookup, the loop's persistence probe) — how `dsh-tools` consumes the seam without gating its fiber on it.
