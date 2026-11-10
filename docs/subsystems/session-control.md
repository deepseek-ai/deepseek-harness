# Session control

English | [中文](session-control.zh.md)

## Summary

Session control sends model-authored messages to independent Sessions and returns an acceptance receipt. The [service](../../packages/session/session-control/README.md) owns attribution, per-target ordering, and provider lifetime; the [local provider](../../packages/session/session-control-local/README.md) restores ordinary Sessions; the [tool](../../packages/session/tool-session-control/README.md) supplies the model-facing input and output.

## Table of Contents

- [Delivery and access](#delivery-and-access)
- [Requests and providers](#requests-and-providers)
- [Cordis API](#cordis-surface)
- [Dev Note](#dev-note)

-----

<a id="delivery-and-access"></a>
## Delivery and access

`sendMessage` addresses any independent Session visible to the current runtime, including one in another Workspace or directory. The runtime supplies the exact live calling Agent and its cancellation signal; model arguments cannot choose the sender. Archived targets reject delivery without being unarchived. A subagent target remains owned by its [subagent controls](subagent.md#messages-and-interruption).

Delivery always steers: a running target receives the message at its next input opportunity, an idle target starts a turn, and an absent target is restored before acceptance. The receipt identifies the message accepted into the inbox; it does not mean the target has answered or completed its work. Cancellation prevents acceptance while still pending and never retracts an accepted message. Failures do not trigger an automatic retry.

The existing subagent `sendMessage` API uses the same service through `sendAgentContent`. Its tree-local name resolution, authority, restoration restrictions, closing coordination, and parent reporting remain with the subagent manager. Both entry paths share target ordering and durable Agent attribution; neither entry grants the other's access rights.

<a id="requests-and-providers"></a>
## Requests and providers

These declarations distinguish business input from the fully attributed message handed to a provider. The `agent-message` source records the real sender; it remains distinct from a human message and from the runtime's subagent settlement notice.

Source: [`packages/session/session-control/src/types.ts`](../../packages/session/session-control/src/types.ts)

```ts type-equiv
/** Trusted execution context supplied by the consumer, never by model arguments. */
interface SessionControlContext {
  /** Exact live Agent whose action sends the message. */
  readonly caller: Agent
  /** Cancels work before acceptance; an accepted message is never withdrawn. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Text addressed to an independent Session. */
interface SessionMessageRequest {
  readonly id: SessionId
  readonly message: string
}
```

```ts type-equiv
/** Content addressed through the existing subagent tree authority. */
interface SessionAgentContentRequest {
  readonly id: SessionId
  readonly content: ContentBlock[]
}
```

```ts type-equiv
/** Receipt for acceptance into the target's inbox, without waiting for its answer. */
interface SessionMessageReceipt {
  readonly messageId: MessageId
}
```

```ts type-equiv
/** Complete message whose identity and attribution are fixed before delivery. */
interface SessionDeliveryRequest {
  readonly id: SessionId
  readonly message: UserMessage
}
```

```ts type-equiv
/** Implementation of Session message acceptance. */
interface SessionControlProvider {
  /**
   * Accept a message once, using steer semantics, restoring a cold target when needed.
   * Recheck cancellation, caller liveness, archive state, and ownership at acceptance.
   * Rejection never causes an automatic retry; a known receipt survives later cancellation.
   * @param request - target and fully attributed message.
   * @param runtime - exact caller and combined provider/caller cancellation.
   * @returns the accepted message identity.
   */
  deliver(request: SessionDeliveryRequest, runtime: SessionControlContext): Promise<SessionMessageReceipt>
}
```

```ts type-equiv
/** Capability held by the subagent lifecycle owner for its existing tree controls. */
interface SessionTreeDelivery extends SessionControlProvider {
  /**
   * Resolve the sender's tree-local display name while checking its runtime ownership.
   * @param caller - exact live sender.
   * @returns the sender's tree-local name or Session id.
   */
  senderName(caller: Agent): string
}
```

```ts type-equiv
/** Durable attribution for one model-authored message between Agents. */
interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the Agent whose tool call produced the message. */
  readonly senderSessionId: SessionId
}
```

The [local provider](../../packages/session/session-control-local/src/index.ts) supplies this resolved composition to ordinary Session creation and restoration.

```ts type-equiv
/** Resolved deployment preset and setup for a fresh ordinary Agent scope. */
interface OrdinarySessionComposition {
  /** Preset identity, absent when the deployment has no preset registry. */
  readonly agentPreset?: string
  /** Composition performed before Agent publication. */
  readonly setup: AgentSetup
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessioncontrol--sessioncontrolservice"></a>

### `ctx.sessionControl` — `SessionControlService`

Shared acceptance service; providers retain their own restoration and closing rules.

```ts cordis-catalog
/**
 * Register the independent-Session provider. Unload cancels and drains pending calls.
 * @param provider - local or alternative implementation of independent-Session delivery.
 * @returns the effect disposer; a replacement may register after it completes.
 */
register(provider: SessionControlProvider): () => Promise<void>

/**
 * Register the existing subagent manager's private delivery capability.
 * @param provider - tree naming, authority, restoration, and acceptance owned by that manager.
 * @returns the effect disposer, which cancels and drains calls before releasing the capability.
 */
registerTreeDelivery(provider: SessionTreeDelivery): () => Promise<void>

/**
 * Send text to an independent Session, returning once its inbox accepts the message.
 * Running targets process it at the next input opportunity; idle targets start a turn.
 * @param request - target Session id and nonblank text.
 * @param runtime - real caller and cancellation before acceptance.
 * @returns the accepted message id; no reply is awaited.
 */
async sendMessage(request: SessionMessageRequest, runtime: SessionControlContext): Promise<SessionMessageReceipt>

/**
 * Deliver existing subagent content under the manager's tree authority.
 * @param request - target and existing content-block representation.
 * @param runtime - exact sending Agent and pre-acceptance cancellation.
 * @returns the accepted message identity, preserving subagent lifecycle bookkeeping.
 */
async sendAgentContent(request: SessionAgentContentRequest, runtime: SessionControlContext): Promise<SessionMessageReceipt>
```

Source: [`packages/session/session-control/src/index.ts`](../../packages/session/session-control/src/index.ts)

<a id="ctxsessioncontrollocal--sessioncontrollocalprovider"></a>

### `ctx.sessionControlLocal` — `SessionControlLocalProvider`

Local delivery owner and caller-owned ordinary Session activation.

```ts cordis-catalog
/**
 * Resolve the preset and its unpublished setup without starting an Agent.
 * @param presetId - requested preset, or the deployment default when omitted.
 * @returns resolved preset identity and scoped setup.
 */
async compose(presetId: string | undefined): Promise<OrdinarySessionComposition>

/**
 * Supply live deployment defaults until a Session records its own model selection.
 * @returns accessors that read the current default route when the Agent needs it.
 */
defaultOptions(): AgentOptions

/**
 * Read the current preset from an exact projected Session observation.
 * @param observation - retained observation carrying the registered projections.
 * @returns the recorded preset, or undefined when none is recorded.
 * @throws when the observation omits its projection snapshot.
 */
presetForObservation(observation: SessionObservation): string | undefined

/**
 * Restore an ordinary Session with its recorded preset and deployment defaults.
 * The caller retains the observation until this resolves. Its calling Context
 * owns the returned handle and disposes it on unload. Cancellation covers
 * acquisition and setup, never later Agent work.
 * @param observation - exact retained Session observation used to select its preset.
 * @param signal - cancellation before the Agent handle is returned.
 * @returns the acquired Agent handle; callers must retain or dispose it.
 * @throws SessionControlError when subagent routing owns the identity.
 */
async resumeObserved(observation: SessionObservation, signal?: AbortSignal): Promise<AgentHandle>
```

Types: [AgentHandle](core.md) · [AgentOptions](core.md) · [SessionObservation](session-query.md)

Source: [`packages/session/session-control-local/src/index.ts`](../../packages/session/session-control-local/src/index.ts)
<!-- END GENERATED cordis-surface -->

<a id="dev-note"></a>
## Dev Note

None.
