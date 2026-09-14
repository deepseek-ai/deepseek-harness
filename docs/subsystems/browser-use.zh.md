# 浏览器操作

[English](browser-use.md) | 中文

浏览器操作让模型通过配置的后端检查与操作网页。DSH 拥有任务循环；提供方提供浏览器操作，并在一个实时 Session 的多个轮次之间保留浏览器状态。

## 选择提供方

在同一组合中挂载 [`dsh-browser-use`](../../packages/browser-use/browser-use/README.zh.md) 和一个提供方。这些提供方是实验性公共 npm 包，需要显式激活。它们最初支持的浏览器引擎是 Chromium。

| 提供方 | 集成方式 |
|---|---|
| [Playwright MCP](../../packages/experimental/browser-use-playwright-mcp/README.zh.md) | Playwright 的浏览器控制 MCP 工具 |
| [Chrome DevTools MCP](../../packages/experimental/browser-use-chrome-devtools-mcp/README.zh.md) | 通过 MCP 进行 Chrome DevTools 检查与控制 |
| [Stagehand](../../packages/experimental/browser-use-stagehand-native/README.zh.md) | 原生浏览器操作，支持 AI（人工智能）辅助的动作、观测与提取 |

共享服务只注册名称，并拒绝任何第二次提供方注册，包括同名实例。它不包含通用浏览器操作方法、浏览器资源或模型控制的选择器。Profile 或 preset 中的提供方配置为此次激活选择启动或附加模式。

## Session 所有权

启动的浏览器属于使用它的确切实时 Agent 与 Session。跨轮次的调用复用该浏览器。Session 运行时释放时关闭其启动的资源；重新加载或 fork Session 时创建全新浏览器状态。浏览器 profile 和登录状态不会从 Session 日志恢复。

附加的浏览器仍归外部所有。提供方在该提供方实例内将浏览器保留给一个 Session，保留现有浏览器状态，并拒绝另一个 Session 同时附加。清理会断开连接并保持外部浏览器运行。独立 DSH 进程与其他客户端不受此保留约束。

提供方关闭时先停止接收工具调用，并等待自有工作与资源清理完成，再释放共享提供方注册。取消无法撤销已交付的浏览器操作。

## MCP 初始化

MCP 提供方为其加载后创建的每个活动 Agent 初始化一个客户端。现有的串行 `agent/created` 事件等待连接和发现结束后，创建或恢复才完成，排队输入才开始运行。客户端跨轮次归 Session 所有。启动失败或取消会拒绝创建或恢复，并触发客户端清理。

如果附加连接已被占用，本次激活不使用浏览器，但继续运行，后续轮次不会重试。连接释放后，新创建或恢复的激活可以获取它。加载或重新加载提供方不会接管已经活动的 Session；[共享运行时](../../packages/experimental/browser-use-runtime/README.zh.md)拥有这些初始化规则。

## 工具与记录结果

提供方工具使用常规 DSH 执行管线与 Session 日志。提供方拥有自己的工具 schema、结果渲染、图像支持、配置和上游限制；共享服务不添加模型可见内容。Stagehand 的 AI 辅助操作使用其显式配置的原生模型，DSH 保留任务循环。DSH 模型路由、凭据复用、底层推理请求/响应捕获，以及与 Session 用量计量的集成均属暂缓工作；返回的 SDK 数据和元数据仍作为普通工具结果记录。

浏览器 MCP 连接还提供[资源和服务器指令](mcp.zh.md)。发往浏览器服务器的资源调用使用其 Session 队列，并拒绝其他 Session 的请求；服务器指令只会组装到所属 Session 的提示词中。

[决策记录](../../.agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.zh.md)解释只注册名称的服务与按 Session 管理的所有权。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowseruse--browseruseregistry"></a>

### `ctx.browserUse` — `BrowserUseRegistry`

Owns one optional provider registration in the shared browser-use service.

```ts cordis-catalog
/**
 * Reserve the sole provider slot until the contribution is disposed.
 * A second registration fails even when it repeats the current name. Providers
 * must stop their tools and await owned work before releasing this registration.
 * @param name - provider-owned name used in registration diagnostics.
 * @returns the effect disposer for this exact registration.
 */
register(name: BrowserUseProviderName): () => Promise<void>
```

Source: [`packages/browser-use/browser-use/src/index.ts`](../../packages/browser-use/browser-use/src/index.ts)
<!-- END GENERATED cordis-surface -->
