# Session 控制

[English](session-control.md) | 中文

## 概述

Session 控制向独立 Session 发送模型编写的消息，并返回接收回执。[服务](../../packages/session/session-control/README.zh.md)负责来源标记、逐目标排序和提供方生命周期；[本地提供方](../../packages/session/session-control-local/README.zh.md)恢复普通 Session；[工具](../../packages/session/tool-session-control/README.zh.md)提供面向模型的输入和输出。

## 目录

- [投递与访问](#delivery-and-access)
- [请求与提供方](#requests-and-providers)
- [Cordis API](#cordis-surface)
- [开发备注](#dev-note)

-----

<a id="delivery-and-access"></a>
## 投递与访问

`sendMessage` 可向当前运行时可见的任意独立 Session 发消息，包括其他 Workspace 或目录中的 Session。运行时提供确切在线的调用 Agent 及其取消信号；模型参数不能选择发送者。已归档目标拒绝投递，不会被取消归档。subagent 目标仍由其 [subagent 控制](subagent.zh.md#messages-and-interruption)负责。

投递始终使用 steer：运行中目标在下一次可接收输入时处理消息，空闲目标开始一轮，不在线的目标先恢复再接收。回执标识已进入收件箱的消息，不表示目标已回答或完成工作。取消可阻止尚未接收的消息进入收件箱，不会撤回已经接收的消息。失败不会触发自动重试。

现有 subagent `sendMessage` API 通过 `sendAgentContent` 使用同一服务。树内名称解析、权限、恢复限制、关闭协调和父级汇报仍由 subagent 管理器负责。两个入口共享逐目标排序和持久化 Agent 来源标记；任一入口都不会授予另一入口的访问权限。

<a id="requests-and-providers"></a>
## 请求与提供方

以下声明区分业务输入与交给提供方的完整来源消息。`agent-message` 来源记录真实发送者；它与人类消息及运行时的 subagent 结束通知保持区别。

源码：[`packages/session/session-control/src/types.ts`](../../packages/session/session-control/src/types.ts)

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

[本地提供方](../../packages/session/session-control-local/src/index.ts)向普通 Session 的创建与恢复提供以下已解析组合。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [AgentHandle](core.zh.md) · [AgentOptions](core.zh.md) · [SessionObservation](session-query.zh.md)

Source: [`packages/session/session-control-local/src/index.ts`](../../packages/session/session-control-local/src/index.ts)
<!-- END GENERATED cordis-surface -->

<a id="dev-note"></a>
## 开发备注

无。
