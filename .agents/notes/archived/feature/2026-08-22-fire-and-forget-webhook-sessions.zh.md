# Agent Note: Fire-and-forget webhook Session

Status: implemented
Archived: 2026-09-30

[English](2026-08-22-fire-and-forget-webhook-sessions.md) | 中文

## Problem

外部仓库事件需要启动普通 DSH 工作，同时不能让每个提供方适配器都理解 Agent preset、Workspace 附加、标题、权限与回调 teardown。GitHub pull request 变为 ready for review 是第一个用途：签名事件可以创建一个评审 Session，用户能在仓库 Workspace 下浏览它。

如果把它变成持久自动化引擎，就会在 Session 旁引入第二套生命周期：交付记录、执行状态、重试与去重策略、崩溃恢复，以及 HTTP 接受、提示词接纳、Agent idle 或模型输出中究竟哪个表示完成。所请求能力不需要其中任何含义。

## Decision

`@deepseek-ai/dsh-webhook` 拥有只有两个操作的 Host runtime：规则通过 `register()` 注册，已验证身份的提供方适配器调用 `dispatch()`。每个匹配回调都作为任意受信任代码独立运行，并返回 `null` 或一个基于 Workspace 的 Session 请求。dispatch 会在回调结算前返回，而 effect disposer 只中止并排空自己拥有的调用。

runtime 不存储提供方交付或执行记录。它不重试、不去重、不恢复回调工作、不观察 Agent 状态，也不收集结果。重复交付可能创建另一个 Session。`WebhookDeliveryId` 仍可供有意通过自有状态实现幂等性的规则使用。

## Provider adapters

身份验证属于提供方适配器。`@deepseek-ai/dsh-webhook-github` 会在注入的 WebServer 上注册一条精确路由，限制未改动的 UTF-8 body，为每次请求解析密钥引用，在解析前验证 `X-Hub-Signature-256`，并把签名无损 JSON 对象交给 runtime。`202` 只表示已验证的内存分发；它先于规则匹配、外部调用和 Session 创建。

普通 Web 组合保持其 UI/API WebServer 独立。GitHub 示例会把另一个 WebServer 及其适配器挂载到只隔离 `webServer` 的 group 中，因此反向代理可以暴露 webhook 端口，而不暴露 `/api`、WebSocket 或前端文件。

Patch 加载会把插入行中的相对插件名锚定到 patch 文件。因而同一个 `./github-ready-review-rule.mjs` 条目既可用于开发环境的 `--patch` overlay，也可用于永久 profile patch，而无需把规则改成软件包。

## Session creation

规则结果会指定本地 Workspace 路径、标题、文本提示词、agent preset、permission preset，以及可选的明确提供方／模型路由与输出上限。没有明确路由时，runtime 会快照包含推理强度的完整实时默认选择，直到首个请求记录其持久 header。runtime 会在变更状态前验证 preset，解析或创建规范 Workspace，以该路径作为 Session cwd 创建 Agent，在发布前挂载 preset，并在接纳提示词前附加 Session。

初始 follow-up 是普通持久 user-role 消息，并携带 webhook 提供方、来源、交付和规则来源信息。它的 inbox 插入是 webhook 操作的最后边界。之后的工作由普通 Session persistence 与 Agent 生命周期拥有；runtime 既不执行特殊 flush，也不等待轮次。

## Alternatives considered

**持久化交付与执行状态。** 否决，因为 `pending`、`admitted`、`running` 与 `settled` 需要当前能力没有消费方的重试、去重、崩溃和完成语义。

**在 Session 创建后再向 GitHub 确认。** 否决，因为任意规则可能调用外部系统并超过提供方 HTTP 时间窗；有效交付不应把传输可用性与后续规则工作耦合。

**在主 WebServer 上注册路由。** 否决，因为操作者需要暴露 webhook 入口而不同时暴露浏览器 API。隔离的第二个实例会复用现有 HTTP 模块，而不会创建另一套服务器实现。

**把规则限制为声明式谓词语言。** 否决，因为程序化规则明确需要任意外部调用。受信任 Cordis 插件已经提供所需权限与生命周期。

**让每个适配器直接创建 Session。** 否决，因为 Workspace、preset、权限、标题、rollback 与来源信息逻辑会散布到各提供方包。

## Verification

包级测试固定独立回调执行、fire-and-forget HTTP 时序、取消与静止态释放、请求验证、提示词接纳前的 Workspace 附加、rollback、GitHub HMAC 与 body 限制、凭据轮换和精确 Loader 组合。组装 Web 示例会向隔离的第二监听器发送签名 ready-for-review 交付，并记录所得普通 Workspace 对话。

真实 API e2e 测试会通过带 webhook overlay 与隔离监听器的构建产物启动 `dsh web` CLI（命令行界面），只合成带签名的入站 GitHub 交付，通过公开 Web API 观察 Workspace 附加与持久来源信息，并等待真实 DeepSeek 响应。测试不会用 test double 替换任何 DSH 服务、模型适配器或提供方调用。

源码审计会保持执行记录、重试 timer、去重 map、完成事件与 Agent 状态监听器不存在。

## Consequences

- 提供方适配器保持小而且只含提供方逻辑，Session 创建只有一个 owner。
- 用户在 Web Workspace 下获得普通带标题 Session，而不是第二套自动化 UI。
- HTTP 成功刻意不说明下游匹配或 Agent 成功。
- 崩溃与重复交付保持简单的进程生命周期内语义；需要持久自动化的部署必须增加单独设计的子系统，而不是重新解释此 runtime。
