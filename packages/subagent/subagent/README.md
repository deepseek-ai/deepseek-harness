---
description: "The subagent delegation seam for users and maintainers choosing a provider backend, composing delegation tools, or debugging child-agent runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent

English | [中文](README.zh.md)

## Summary

Use `dsh-subagent` to delegate work through named providers and collect managed activation results. Local spawn and fork children retain durable sessions for later messages; ACP, DSH SDK, Codex, and Claude Code execute once. Every child shares admission, cancellation, ownership, and discovery. Compose the service with a provider and a delegation tool.

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

Each start accepts an optional `cwd`; relative paths resolve against the parent's current working directory, and omission captures that current directory. The child keeps its parent's origin metadata and permission roots. A child-owned directory value follows any inherited history, survives continuation and restart, and is independent of later parent changes.

This package is the contract every delegation setup shares. You enable it by mounting the service together with one or more provider backends and the model-facing delegation tool; from then on, an agent can delegate work and the service routes each request to the named provider.

### Enabling delegation

Mount the service with `@deepseek-ai/dsh-session-projection`, a provider, and the delegation tool; the service waits for the projection registry before initializing. The provider registers under its configured name; each tool row selects one provider. A minimal setup:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

The tool returns the child's name immediately. The parent receives a completion notice when the background activation settles. Mounting the service alone enables no delegation.

### Delegation settings

The limits section on the **Plugins → Subagent** page edits the Host’s `subagent` settings section. User values override this plugin's composition; reset removes the user override. `maxDepth` defaults to `1` and supplies the delegation tools' depth when their own configuration omits it. An explicit tool depth, including `provider-managed`, takes precedence. Depth `0` disables delegation through tools inheriting this setting; depth `1` permits direct children only. Changes apply on the next delegation attempt. Direct service callers continue to supply their own optional request depth.

### Activation capacity

Set `maxActiveSubagents` on the host plugin to limit live and materializing children in each subagent tree. It defaults to `8` and accepts positive safe integers. A top-level parent starts a pool shared by its local and external descendants; the root parent consumes no slot. Creation and cold resume reserve before yielding, and disposal returns the slot only after cleanup. Instances with pending inbox work and stopping activations remain counted. Sending to a resident child reuses its slot. Delegation depth is a separate policy.

The current `maxActiveSubagents` value is sampled before every new or cold-resumed Activation. Raising it admits more children in existing trees; lowering it leaves resident children running and refuses further admissions until usage is below the limit.

At capacity, creation or cold resume rejects with `ACTIVATION_LIMIT_REACHED` (browser prompts receive `subagent/delivery-unavailable`): wait for a child to finish or continue using the existing agents. Admission does not queue, because a parent waiting for descendants must not wait for its own occupied slot. Slots are process-local and do not constrain cumulative Session history or token usage.

### Local and external children

`startActivation({ provider, label, name?, prompt, parent, signal, delivery })` returns `{ childId, name, messageId?, result, dispose }`. Supplying `childId` selects a local backend and guarantees `messageId`. Local children accept later messages and can cold-resume; external children expose one execution and reject continuation. `agentOptions` overrides supported child model settings. `delivery: 'parent'` supplies the model-facing completion notice; `delivery: 'caller'` lets workflows await the result without a parent notice or initial return guidance. Local parent delivery requires persistence; caller delivery can use an ephemeral local session. Cold resume requires persistence and Session query.

`rootOf(agent)` resolves a managed local Agent through its existing Activation and checks the exact live child and root instances. Intermediate creators can leave without changing that root; same-id replacements cannot inherit membership. Ordinary live Agents resolve to themselves, while unmanaged delegated Agents are rejected. The query does not activate Sessions.

<a id="agent-names"></a>
### Agent names

Every cataloged child has a name that is unique among its creator's children. Pass `name` to choose it: 1–32 lower-case letters, digits, or hyphens, starting with a letter, other than `lead`. Omission selects the first free `agent-N` (`agent-1`, `agent-2`, …) among the names in the creator's catalog and the names held by creations still starting. A name that a sibling already holds rejects with `DUPLICATE_AGENT_NAME`, and a name that breaks the rule rejects with `INVALID_AGENT_NAME`; both reject before startup, and the runtime never substitutes another name. The creator reserves the name synchronously at admission and releases the reservation when the catalog entry commits or startup fails. Caller-delivered external runs enter no catalog: they reject a requested name with `UNSUPPORTED_CAPABILITY`, and their activation name is their Session id.

The root is always `lead`. A descendant's full name is the slash-separated path of names from the root without a `lead/` prefix, such as `reviewer` or `reviewer/checker`; sibling-unique segments make full names unique in the tree. `SubagentActivation.name` and the `path` field of `listDescendants()` rows carry the full name. A child whose catalog entry has no name, and every descendant below it, uses its Session id as its name. `namesOf(agent)` reports a live member's name and its creator's name. `resolveName(caller, name, signal)` returns the Session id for `lead` or a full name, reading only the catalogs along the path. Any other text that names no member is returned unchanged as a Session id, because a single token can be one; a slash-separated address never is, so an unmatched path fails with `AGENT_NAME_NOT_FOUND`. Resolution grants no authority: messaging, interruption, and task assignment authorize the resolved Session id.

### Child presets

In-process spawn accepts an independent `agentPreset`; fork and external backends reject this option. Without a selection, a local child joins the parent's current preset revision. An explicit id mounts the currently available revision, even when that id matches the parent's. Configure model choices through [`dsh-tool-subagent`](../tool-subagent/README.md#selecting-a-child-preset) and persona and tools in the [preset composition](../../preset/agent-preset-registry/README.md). Cold resume preserves persona and tool restrictions recorded in historical child descriptors.

### Messaging, interrupting, and discovering

`sendMessage()` lets the live root and resident continuable subagents contact any other root or continuable member in the same tree by Session id. The target receives Steer input at its next step or starts an idle turn. Only the cold target resumes, under the subagent tree root; its creation ancestors stay offline and the message retains its actual sender. `rootOf()` resolves the caller’s live root. Agent interruption requires ancestor authority. Browser prompts and user interrupts address only the child Session; the Gateway checks the corresponding action on that Session before any side effect. Parent or global grants do not imply child access. Prompts require a live subagent tree root; the creator may be offline. User interrupts perform no restoration and accept absent targets as no-ops. They select Queue or Steer and admit image batches through the attachment store; incompatible target models reject images. `listDescendants()` discovers members recursively through parent-owned `subagentCatalog` projections. It preserves catalog order, reads each reachable Session once, skips external leaves, and reports unreadable branches without activating Agents.

### Failure and recovery

Starting without the `agents` service rejects with `CONTINUATION_UNAVAILABLE`; an available runtime rejects a missing or replaced parent with `UNAUTHORIZED`. Providers implementing neither execution method are rejected at registration with `UNSUPPORTED_CAPABILITY`; unsupported requested capabilities reject creation with the same code. If a provider is removed or replaced while directory resolution is pending, creation rejects with `PROVIDER_CHANGED` before invoking either provider; retry the delegation against the current registration. The caller signal cancels only unpublished work; after publication, `dispose()` cancels the exact activation and waits for its resource cleanup. Creation descendants continue independently; hosts must await `drainDescendants([root])` before disposing the root handle to stop all members and await pending startup. `result` settles after teardown and notifications, carrying output, optional structured data, and a stop reason; capture failures reject it after teardown. Cleanup failures reject `dispose()` and mark the lifecycle end as failed; the result promise and parent notification retain the captured execution result.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service is built and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **One service, many providers.** The service is a named-provider registry; each backend registers under a unique name and a request picks one by name.
- **One managed lifetime.** `SubagentManager` owns startup, message admission, capacity, runtime ownership, and disposal. Each activation retains its lifecycle identity and a local AgentHandle or external SubagentRun; the manager publishes paired events through the service's scoped emitter. Local inbox and idle state belong only to the local variant.
- **Fulfillment is publication.** `startActivation()` returns only after the child is accepted and its handle can cancel that exact execution.
- **Trusted same-process values.** Requests, descriptors, and results are borrowed immutable; serialization and hostile-input validation belong at process and wire boundaries.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service entry: provider registry, start and continuation API, lifecycle events |
| [`src/manager.ts`](src/manager.ts) | Unified startup, message admission, cold resume, runtime ownership, settlement, and disposal |
| [`src/activation.ts`](src/activation.ts) | Execution records, capacity slots, child locks, and local output capture |
| [`src/continuation-messages.ts`](src/continuation-messages.ts) | Agent messages, return guidance, and settlement notices |
| [`src/structured.ts`](src/structured.ts) | Activation-scoped structured capture and guards |
| [`src/types.ts`](src/types.ts) | Public request, result, and provider contracts |
| [`src/descriptor.ts`](src/descriptor.ts) | Versioned `subagent/descriptor` session-event vocabulary |
| [`src/catalog.ts`](src/catalog.ts) | Parent-owned `subagent/catalog` event and chunked host projection |
| [`src/child-agent.ts`](src/child-agent.ts) | Child composition, delegated policy, depth helpers |
| [`src/list-children.ts`](src/list-children.ts) | Direct and recursive parent-catalog reads |
| [`src/control.ts`](src/control.ts) | Browser control request validation and stable failure codes |
| [`src/control-types.ts`](src/control-types.ts) | Client-safe catalog row, control requests, receipts, and failures |
| [`src/archive-admission.ts`](src/archive-admission.ts) | The `subagent` family of the Workspace registry's archive admission: running descendants and their parent-cause cancel |

### Provider preparation and structured output

The service validates requested capabilities and binds execution to that exact provider instance before creation. The manager receives the bound operation rather than a provider lookup. Local providers supply only `prepareContinuable()`: spawn returns fresh state and fork returns a completed-turn seed. The manager captures the parent model settings, delegated permissions, and composition before creating the child. External providers retain `start()` as a transport adapter and retain their own permission systems. The common manager owns their published execution. Structured tools, instructions, validation, and terminal guards belong to one local activation; they are not persisted as resume configuration. The child can submit its structured result after consuming accepted input. Work that depends on descendants must explicitly wait for their results. Staging a result closes further input through tool-result policy and any enclosing PTC execution; a rejected result reopens input, while a committed result keeps it closed. Later cold resume has no structured schema.

External providers mint a fresh `SubagentRun.id` for each execution in the runtime's shared Session id namespace, across all parents and providers. A collision with a resident Agent, Session, or activation rejects startup with `DUPLICATE_CHILD` and disposes the new external handle without replacing the existing execution.

### Activation settlement

The manager reserves child identity and capacity, materializes a local Agent or external execution, and accepts the initial task. Local admission closes after Agent activity and pending input finish, with activity revalidated after the final Session flush. Both local and external activations deliver their result after handle cleanup, capacity release, and settlement notifications. Host waits on the subagent tree root join progressing members and their cleanup, including failed executions; idle members with parked input remain resident without delaying host completion. Ordinary members do not wait for descendants. Closing admission and disposing the handle prevent late work from entering a released Agent. Parent delivery emits its notice after settlement only if the creator is still online; caller delivery leaves collection to the awaiting workflow. Headless hosts repeat `agent.whenIdle()` and `waitForTreeWork(agent)` until no child work remains and the parent stays idle with an unchanged Session sequence across the child check, so completion notices can produce the final parent answer.

Settlement attribution records the exact execution stop reason without altering model-facing notice content. Historical notices can omit this field; readers must not infer it from the English summary.

A local Agent failure without a subsequently committed `turn/end` settles as `error` independently of its descendants. Unclaimed input cannot keep that failed activation resident. A later committed turn ending supersedes the live failure and supplies the recovered outcome.

Successful local creation appends a `subagent/catalog` fact to the parent Session regardless of result delivery. External creation appends a catalog fact only with `delivery: 'parent'`; caller-owned external executions retain their caller's membership records. External entries use `mode: 'external'` to identify children without a local Session. Catalog entries record membership once at creation and carry no execution status. Complete results go to the caller or the parent completion notice. Projections exclude inherited facts. Direct lists read one parent projection, so completed local workflow children remain discoverable and can be opened or continued. Catalog payload v0 records local modes; v1 also accepts unknown mode; v2 records external executions; v3 adds the child's name to continuable and external entries. Local and parent-delivered external creation write v3, and readers support all four versions. The `subagentCatalog` projection state version remains 6: unnamed checkpoints are reused, and suffix replay appends named facts without replaying the checkpoint prefix or backfilling historical names. Historical migration appends a v1 `subagent/catalog` from a readable child header when its descriptor is unavailable. Its `mode: 'unknown'` projection keeps the child visible without claiming continuation support; an existing complete entry remains authoritative.

<a id="restoring-child-composition"></a>
### Restoring child composition

Cold resume mounts the target's saved preset from its `agentPreset` projection or creation header without reading its creator's current composition. A missing or broken saved preset rejects restoration. The original subagent provider need not remain registered.

Targets without a saved preset use the host composition and retain their historical descriptor's persona and tool restrictions. Persisted permission policies replay from the target's own log. Restoration uses the currently registered preset definition, without preserving an earlier revision across restarts.

### Ownership and invariants

- **The manager owns accepted work** — unpublished failures roll back; published handles cancel and release only their exact activation. Every instance belongs to the subagent tree root; creation parent ids remain unchanged.
- **Registration is effect-scoped** — removing a provider blocks new starts but never revokes accepted runs.
- **Agent-message authority follows the tree** — the exact live sender and target must belong to one root. Cold delivery verifies the target descriptor and creation catalogs before restoring only the target. Final inbox admission rechecks the sender and subagent tree root; failed restoration releases the new instance.
- **The descriptor is log-only** — a session event absent from model history and retained across compaction; the writer records the resolved child provider, model, and reasoning effort for cold resume. Historical one-shot descriptors remain readable.
- **This runtime answers archive admission for children** ([seam](../../workspace/workspace/README.md)) — activity queries, parent-cause cancellation, and pre-step rejection use managed creation ancestors even after an intermediate creator goes offline. Agents without a published Activation use live header ancestry; ordinary forks remain independent. Labels use the current identity projection's latest descriptor only when it belongs to the child's own log; missing, invalid, inherited, or unlabelled identities report only the id. Reporting requires no Session query service and starts after identity projection registration. Each cancellation failure is contained. The Agent registry owns the parent’s turn, job providers own jobs, and the API Session Controller checks archived Sessions and available header ancestry.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared seam to the backends, the model-facing tools, and the design decisions.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [historical Subagent capability seam](../../../.agents/notes/archived/feature/2026-06-21-subagent-capability-seam.md) — the design record for the delegation capability family.
- [Continuable subagents](../../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md) — durable children that accept follow-up turns.
- [In-process spawn backend](../subagent-spawn-in-process/README.md) — the simplest provider to compose.
- [Auto review](../../experimental/auto-review/README.md) — the current-session authorization mode inherited only by in-process DSH children.
- [Out-of-process ACP backend](../subagent-acp/README.md) — children with their own runtime over the Agent Client Protocol.
- [DeepSeek input conversion](../../llm/llm-deepseek/README.md#model-experience) — provider replay rules for saved settlement notices.
- [tool-subagent-control README](../tool-subagent-control/README.md) — the follow-up, interrupt, and listing surface.

-----

<a id="model-experience"></a>
## Model Experience

### Settlement notice

#### What the model sees

Parent delivery sends a user-role status notice to the resident direct parent in the same tree, including an idle parent. It does not restore an offline parent. Its opening line names the child by its full name, such as `Background subagent reviewer finished and will do no further work unless you send it more.` The notice contains the child’s nonempty final text blocks. When the child's last action before that text was a message to its parent, with no input claimed and no tool call logged after it, the notice replaces them with `It sent you a message just before finishing, so its closing message is omitted.`; the parent recovers omitted closing text only by messaging the child again. External notices also state that further messages are unsupported. Reasoning and other nontext blocks are excluded. Every parent notice includes available structured output as `Structured result: <JSON>` and the provider’s safe diagnostic as a separate text block. Empty closing text is reported as `It left no closing message.` Caller delivery emits no notice; SDK lifecycle notifications retain complete child output when cleanup succeeds.

#### Token effect

One notice per settled activation using parent delivery; a default name such as `agent-1` is shorter than the 36-character Session id that names a child without a recorded name. Caller delivery adds no completion message; its consumer owns result presentation.

#### KV Cache effect

Append-only in the parent: the notice follows its reusable request prefix. Reaching an idle parent starts one independent model request; reaching a busy one does not.

### Continuable child return guidance

#### What the model sees

Local children using `delivery: 'parent'` receive the result-delivery guidance below in their initial task, whether or not messaging tools are installed. Tool usage and communication identity belong to [tool-subagent-control](../tool-subagent-control/README.md).

##### Return guidance

```markdown
Your final answer is delivered automatically if your parent is still online. Include the result and relevant evidence in that answer; the parent does not receive your full transcript, tool output, or reasoning. If your last action is a message to your parent, the completion notice omits your final answer; include the result and relevant evidence in that message.
```

#### Token effect

One fixed guidance block per local parent-delivered child's initial task; caller delivery adds none.

#### KV Cache effect

The guidance remains in the child's retained task history. It does not change the parent's system prompt.

### Child delegation-scope statement

#### What the model sees

Every in-process child's runtime-context snapshot carries the `subagent:delegation` statement below, after the sandbox-policy and approval-policy sentences.

##### The delegation-scope statement

```markdown
You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the job needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.
```

#### Token effect

One fixed statement in each child's runtime-context snapshot; none in the parent's requests.

#### KV Cache effect

Prefix-stable within a child: the statement never changes during the child's lifetime, so it is written once into the first runtime-context snapshot. Parent-side, no direct invalidation; the named tool consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the seam is a poor fit or needs special operational care. They are current package constraints, not a general delegation comparison or a task backlog.

- **Descendant reads are sequential** — each reachable catalog, including one-shot children, takes one observation. A cold Session without a valid prepared observation requires a full-log read; large cold trees can accumulate storage latency.
- **Names are permanent** — a name stays taken among its creator's children for as long as the catalog entry exists; names cannot be changed or reused, and no migration names children whose catalog entries predate names.
- **External children execute once** — ACP, DSH SDK, Codex, and Claude Code have no local child Session and accept no follow-up input. Their parent-owned records remain discoverable after disposal.
- **Messaging stays within one tree** — targets must be the root or continuable members. Only the restored target consumes activation capacity. Browser prompts retain their separate human Queue-or-Steer control path.
- **Wake gap during cancellation convergence** — a follow-up accepted after an interrupt signal but before the Agent becomes idle stays queued until another waking send.
- **Pending injected context retains an Activation** — settlement conservatively treats every Inbox occurrence as unfinished. Context parked after the Agent becomes idle keeps the child and its live ancestors resident until a waking delivery claims it, a queue mutation removes it, or manager teardown discards it. Host completion joins active work, pending child creation, and resource cleanup, but does not wait for a subtree containing only idle parked inboxes; it neither completes those activation results nor discards their messages.
- **Process-local residency** — the Activation inbox and ownership graph do not coordinate two harness processes; concurrent access to one persistence store needs a durable mailbox and cross-process lease protocol.
- **No replay of accepted-but-unlogged messages** — a crash can lose an accepted prompt that never reached the child's session log; the lost message is not replayed automatically.
- **Lifecycle events are observe-only** — a run-affecting `subagent/end` continuation or decision API waits for a concrete consumer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Cross-process continuation** — a durable mailbox and lease protocol would let two harness processes share one persistence store.
- **Continuable ACP children** — requires persisting the remote session id and a per-child continuation advertisement.
- **Host-user delivery** — a future host adapter needs a concrete authenticated interaction before the seam gains a user delivery capability.

</details>
