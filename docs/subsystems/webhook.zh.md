# Webhook runtime

[English](webhook.md) | 中文

Webhook 子系统会把已通过身份验证的外部交付转换为可选的普通根 Session。提供方适配器拥有身份验证与通用 JSON 接收；受信任的程序化规则拥有条件与外部调用；`ctx.webhookRuntime` 拥有回调生命周期以及基于 Workspace 的 Session 创建。[历史已实现决策](../../.agents/notes/archived/feature/2026-08-22-fire-and-forget-webhook-sessions.md)记录了 runtime 为何不保留交付或完成状态。

## 共享值

`WebhookRuleId`、`WebhookSourceId` 与 `WebhookDeliveryId` 是不透明字符串。交付 id 仅用于来源信息：runtime 既不存储也不对它去重。

`WebhookEventMap` 可按提供方种类合并扩展。`WebhookEventOf<K>` 会选择已知提供方事件，否则接纳通用无损 JSON，从而让树外适配器无需修改 runtime 包。

`VerifiedWebhookDelivery<K>` 包含 `kind`、已配置 `source`、提供方 `deliveryId`、规范化 `event` 与非负安全整数 `receivedAt`。runtime 会先验证、分离并冻结完整值，再把它分发给多个规则。

`WebhookRule<K>` 包含唯一 id、提供方种类与 `run(delivery, signal)`。回调可以执行任意受信任代码。它返回 `null` 或一个 `WebhookSessionRequest`，并且异步工作若应在注册卸载时停止，就必须观察 signal。

`WebhookSessionRequest` 要求绝对 `workspacePath`、标题、文本提示词、agent preset 与 permission preset。可选 `model` 会指定明确的提供方／模型路由与可选输出 token 上限，并使用该适配器的默认推理强度。省略时会快照包含推理强度的完整当前部署选择，直到首个请求记录持久 header。

## Fire-and-forget 分发

`dispatch()` 会快照匹配规则，彼此独立地调度每个规则，并在任何回调结算前返回。抛出与拒绝按规则分别被包含。注册 disposer 会先移除规则，再中止并排空活动调用，因此后续交付无法进入正在卸载的代码。

runtime 没有队列、重试、去重、执行状态、崩溃重放、Agent 状态监听器或完成结果。重复交付可能创建重复 Session。唯一的活动操作表是私有 teardown 记账，并随进程消失。

## Session 创建

非 `null` 结果会在异步预检前生成快照。runtime 会验证 permission 与 agent preset，解析或创建规范 Workspace，创建 Session cwd 等于 Workspace 路径的 Agent，在发布前挂载所选 agent preset，并在应用权限、标题与初始 follow-up 前持久附加 Session。

follow-up 是普通持久 user-role 消息，使用 `source.kind: "webhook"`，并携带提供方／来源／交付／规则来源信息。其 inbox 插入被接受时提交 webhook 操作。runtime 不执行特殊 flush，也不等待轮次；之后应用普通 Session persistence 与 Agent 生命周期。

附加失败会在提示词出现前释放新 Agent。附加之后、提示词接纳之前的失败会尝试脱离 Workspace 并释放 Agent，且不会取代原始错误。预检期间自动创建的 Workspace 会保留，因为另一个并发调用者可能已经使用它。

## GitHub 适配器

`@deepseek-ai/dsh-webhook-github` 在注入的 WebServer 上注册精确路由，为每次请求解析凭据引用，在解析前验证未改动的 `application/json` body，并在内存分发后立即返回 `202`。它的规范化事件保证为已签名的无损 JSON 对象；规则负责验证自己消费的事件特定字段。

[GitHub 评审指南](../user/guide/github-review.zh.md)把该路由挂载在隔离的第二个 WebServer 上，因此暴露 webhook 入口不会暴露浏览器 API。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxwebhookruntime--webhookruntime"></a>

### `ctx.webhookRuntime` — `WebhookRuntime`

Fire-and-forget rule runtime. Session creation is the only built-in action.

```ts cordis-catalog
/**
 * Register one trusted programmatic rule.
 * @param rule - unique id, provider kind, and arbitrary callback.
 * @returns awaitable effect disposer that aborts and drains this rule's active callbacks.
 */
register<K extends string>(rule: WebhookRule<K>): () => Promise<void>

/**
 * Start every currently matching rule and return before any callback settles.
 * @param delivery - authenticated provider data; snapshotted before dispatch.
 * @throws synchronously when the runtime is closing or the delivery is malformed.
 */
dispatch<K extends string>(delivery: VerifiedWebhookDelivery<K>): void
```

Source: [`packages/experimental/webhook/src/index.ts`](../../packages/experimental/webhook/src/index.ts)
<!-- END GENERATED cordis-surface -->
