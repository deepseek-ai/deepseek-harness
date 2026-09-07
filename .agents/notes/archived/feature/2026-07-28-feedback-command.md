# Agent Note: `/feedback` command

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-28-feedback-command.zh.md)

## Problem

A user who notices something wrong mid-session has nowhere to put that observation. Telling the model wastes a turn, changes the conversation the user was having, and buries the remark in derived history where no later reader can find it. Writing it outside the session loses the context that makes it meaningful — which session, at which point, against which work.

The capture surface has to be usable at the moment of annoyance, which rules out anything requiring the user to leave the interactive client, and it must not perturb the run in progress: no model tokens, no turn of work, no change to the request the user is waiting on.

## Decision

`@deepseek-ai/dsh-command-feedback` in `packages/feedback/command-feedback/` registers one global `feedback` command over `ctx.commands`. `/feedback <text>` acknowledges with the receiving session id and the shared harness-home anonymous user id; bare or whitespace-only input returns a direct usage error. The handler is synchronous, injects only `commands`, and has no configuration. [The shared-id decision](../architecture/2026-08-07-shared-feedback-telemetry-user-id.md) records why feedback and OpenTelemetry use the same `$DSH_HOME/.anonymous-user-id` value.

The package declares the log-only `feedback/record { text }` session event and exports `recordFeedback(session, text)` as its command-independent producer. The producer discards surrounding whitespace, rejects an empty result, and appends exactly one event. `/feedback` delegates to it, so another UI, hook, or host integration can record the same domain fact without constructing a slash command.

`dsh-commands` still writes its `command/run` / `command/done` lifecycle pair around `/feedback`, but this command sets `recordInput: false`. Its `command/run` therefore carries the command identity and source without `args`; the feedback text exists only in `feedback/record`, while `command/done` carries the acknowledgement outcome. All three records are log-only and non-surface. Their appends enter persistence's ordinary bounded write path; nothing forces a flush, so acknowledgement reports that the feedback is in the log rather than already on disk.

Capture remains inert for the running agent and model. The optional OTel telemetry package later adds one infrastructure consumer: it observes `feedback/record` as a release trigger in `FEEDBACK_ONLY` mode and as the local-only warning trigger in `DISABLED` mode, without changing the feedback event or command path. See [Feedback-gated session telemetry](2026-08-05-feedback-gated-session-telemetry.md) and the [acknowledgement sharing disclosure](2026-08-07-feedback-acknowledgement-sharing-disclosure.md).

### Why feedback owns an event

Feedback is a domain fact, while `/feedback` is one trigger. Keeping the only payload in `feedback/record` lets later triggers use the same event and lets consumers select feedback without depending on command names or parsing command lifecycle records. Omitting `command/run.args` for this definition avoids two authoritative-looking copies of one human remark.

### Why the model never sees it

Feedback is about the session, not input to it. Injecting it as a user message would change the next model request, contradicting the requirement that recording not perturb the run, and would make the remark part of the conversation it comments on. `command/run` and `command/done` are absent from `SurfaceEventType`, so they cannot acquire a `surfaceOp` or enter derived history even by mistake.

### Verbatim text

Surrounding whitespace is discarded, but nothing else is parsed. `/feedback /plan felt slow` records `/plan felt slow`; the leading `/plan` is content, not a nested command. Control-word grammar of the kind `/goal` uses would make the corresponding literal feedback impossible to express, which is the opposite of what a capture surface is for.

### A new group

`packages/feedback/` is a new group because no existing one owns this. `goal/` is objective state, `session-title/` is titles, `core/` is the product spine. The group holds one producer package; cross-cutting consumers stay in their owning groups rather than forcing this one to grow.

## Alternatives considered

**Use `command/run` as the feedback record.** Rejected because feedback would then be coupled to one trigger and consumers would have to identify a domain fact by command name. A non-command producer could not create the same record without pretending to execute a command.

**Store the text in both `feedback/record` and `command/run.args`.** Rejected because one act would have two payload copies with no useful distinction. `recordInput: false` preserves the generic lifecycle while leaving the domain event authoritative.

**Inject feedback as a user message via `agent.inject()`.** Needs no new event type and reuses the path `/goal` mutations take. Rejected: it makes the feedback model-visible, so it enters the next request, changes the run being commented on, and consumes tokens — contradicting all three parts of the no-perturbation requirement.

**Make `/feedback` a true no-op that records nothing.** The most literal reading of "does not do anything". Rejected because it makes the command pointless: the stated requirement was that the remark reach the session log.

**Register the command inside an existing package** such as `packages/interaction/commands`. Avoids a new group and its README pair. Rejected: `ctx.commands` is the registry, not a home for arbitrary command implementations, and the requester asked for a standalone package.

**Parse structure out of the text** (category prefixes, severity markers). Rejected as speculative: no consumer needs that structure, and any control-word grammar makes the corresponding literal feedback unrecordable. Verbatim text is the widest surface a future consumer can narrow; a parsed one cannot be widened after the fact.

**Add a model-facing tool instead of a slash command.** Rejected: feedback is a direct human observation. Routing it through the model spends a turn, lets the model paraphrase the user's words, and makes the record contingent on the model choosing to call the tool.

## Consequences

The shipped `dsh` base mounts the command unconditionally — no configuration, no dependency on the goal stack. The Web client exposes it through its command adapter. Headless mode, ACP, and JSON-RPC do not provide a command adapter, so `/feedback` is unavailable there. The first accepted feedback for a harness home can create `$DSH_HOME/.anonymous-user-id`; rejected empty input does not resolve or create an id.

The package owns one independent append-only event with no cross-event or mutable-data relation for an invariant companion to check. The event follows the session log's existing replay, fork, persistence, and crash-tail behavior.

Deferred: no product or model consumer; no structured fields; no amend or withdraw, since the log is append-only and this package adds no tombstone; and no explicit durability barrier, so an entry recorded immediately before a crash can be lost with any other unflushed tail. The optional telemetry consumer treats the event only as an export-policy trigger.

No keyless transcript snapshot accompanies this change, at the requester's explicit direction. Package tests, a real Loader composition test over a `cordis.yml`, and the shipped Web composition test cover registration, capture, model exclusion, and product assembly.
