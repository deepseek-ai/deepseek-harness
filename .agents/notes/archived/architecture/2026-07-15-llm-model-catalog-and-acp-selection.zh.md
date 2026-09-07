# Agent Note: 建议性 LLM 目录与 ACP 会话级模型选择

Status: implemented
Archived: 2026-09-04

[English](2026-07-15-llm-model-catalog-and-acp-selection.md) | 中文

> Catalog 和 scoped selection 决策仍然有效。ACP selection 的暂时移除已由[标准 ACP v1 自动化控制](../feature/2026-08-22-standard-acp-automation-controls.zh.md)取代；后者通过标准会话配置公开 catalog，但不会恢复 UI 投影。

## 问题

基于提供方路由的适配器允许每次请求选择 `provider + model`，但 `LlmRuntime` 只暴露路由和流式调用。UI 无法发现已注册的提供方，也无法知道适配器愿意推荐哪些模型。因此，ACP 客户端收不到 `model` 会话配置项；即使 LLM（大语言模型）服务已经支持运行时切换，Zed、JetBrains 和 VS Code 集成仍没有模型列表。

模型发现不能变成请求校验。手写 DeepSeek 适配器会把任意模型 ID 原样转发给公开或私有端点，而 pi-ai 的有限安装目录则是其自身请求解析的权威依据。将共享目录视为白名单，会破坏提供方路由需要保留的私有端点能力。

ACP 选择还必须保留提供方维度。同一个模型 ID 可能存在于多个路由下；切换全局适配器或 agent（智能体）模板会让一个编辑器会话的选择泄漏到其他会话。提示词变量与请求路由必须同时变化；如果选择发生在异步提示词组装期间，不能让 `{{model}}` 表示一个模型、实际请求却到达另一个模型。

## 决策

### 提供方无关的建议性发现

`LlmAdapter` 增加 `providerInfo(provider)` 与异步 `listModels(provider)` 方法。其提供方无关结果分别为 `LlmProviderInfo { id, name }` 和 `LlmModelInfo { provider, id, name, description? }`。默认实现以路由名称作为提供方名称，并且不展示模型，从而保持现有适配器行为。

`LlmRuntime.listProviders()` 按注册顺序返回元数据副本。`LlmRuntime.listModels(provider)` 委托给路由所有者，校验非空 ID 和名称，并在提供方不匹配或模型 ID 重复时以 `INVALID_CATALOG` 失败，最后返回值的副本。未知提供方仍以 `NO_ADAPTER` 失败。提供方元数据在 `registerAdapter()` 期间进行原子校验，错误展示记录不会留下部分注册。

目录成员关系仅提供建议。它驱动选择器与诊断，但不会改变 `stream()` 路由，也不会拒绝原本有效的请求。提供方所有权仍然具有排他性并绑定生命周期；模型 ID 仍是请求时传给适配器的输入。

`dsh-llm-pi-ai` 将已配置提供方的 `getModels(provider)` 返回的已安装条目映射为提供方无关的目录。其现有请求时目录查询仍是权威依据，未知模型仍以 `UNKNOWN_MODEL` 失败。`dsh-llm-deepseek` 接受包含展示条目的可选 `models` 配置，默认包含名为 `DeepSeek-V4-Flash` 的 `deepseek-v4-flash`、名为 `DeepSeek-V4-Pro` 的 `deepseek-v4-pro`，以及名为 `DeepSeek-V4-Flash-Vision-Exp`、支持图片输入的 `deepseek-v4-flash-vision-exp`。显式列表会替换这些默认值，空列表则关闭发现。这些条目改善已知公开或私有模型的选择体验，而所有未列出的模型 ID 仍会原样透传。

### 前端内的会话级选择

选择由提供它的前端拥有，而不由 `LlmRuntime` 或 `AgentOptions` 拥有：它们是部署级或创建级对象，改动它们会把并发会话耦合在一起。每个不透明选项都携带完整的提供方／模型对，因为同一模型 ID 可能出现在多个路由下。

ACP 自动化传输层通过标准会话配置选项消费建议性 catalog。部署配置仍提供初始提供方／模型目标；每个会话拥有一个不透明的提供方／模型选择，以及一个依赖确切模型的 reasoning-effort 选择。Adapter 拓扑变化会公布完整选项状态。Catalog 中缺少条目不会使配置路由失效：当前未列出的路由会合成到选项中。

### 提示词／请求一致性与持久化

`installModelSelection`（位于 `dsh-agent`）为前端拥有的选择安装 agent 作用域的 `system-prompt/assemble` 与 `agent/request` 监听器。普通 consumer 每个步骤快照一次选择。ACP 会在 per-session 模块中把准入快照与已识别消息关联到 inbox claim 时刻，再在完整已准入轮次中固定该选择，使异步图片准入、提示词变量和每个请求步骤保持一致，同时不改变持久用户 source。并发选择变更从下一个 ACP 轮次开始。其他调用配置字段保持不变。

请求头仍是持久化的真源。当某个选择真正被使用时，现有的完整 `request/header` 快照会记录它；前端先从折叠后的最后一个请求头初始化其选择，然后才回退到创建选项。从未被请求使用的选择有意只保留在内存中，因为它从未成为模型可见状态。

## 考虑过的替代方案

**只返回模型字符串。** 只有模型的值会丢失提供方路由，一旦两个提供方暴露相同 ID 就会产生歧义。

**将目录设为强制白名单。** 这与手写适配器的任意模型透传和私有部署冲突。请求的权威校验本就属于被选中的适配器。

**把选择存进 `AgentOptions` 或 `LlmRuntime`。** 它们是创建级或部署级对象。改动它们会把并发会话耦合在一起，并绕过有日志记录的 `agent/request` 替换路径。

**立即持久化一个新的模型选择会话事件。** 未被使用的 UI 选择尚未影响任何模型请求。在目标被消费时记录现有请求头，既保持「模型可见当且仅当有日志」的规则，又不会引入第二个真源。

## 结果

- 任意适配器都能暴露动态模型列表，无需把提供方库类型泄漏到 LLM Service Definition。
- 目录消费方必须把缺失理解为「未展示」，而不是「请求无效」。
- pi-ai 适配器会暴露其已安装的提供方目录；手写 DeepSeek 部署显式列出已知选项，同时保留对任意模型的支持。
- 每个 catalog consumer 拥有自己的选择交互。ACP 使用标准会话配置选项，不发出 DSH 专用 selector 或 UI 元数据。
- 请求头与基于提供方路由的会话形态保持兼容；不需要新的 JSONL 事件或格式版本。
- 目录读取可以是异步的，且每个调用方都会收到值的独立副本。

## 测试

单元测试覆盖 catalog 值副本与格式错误的元数据、pi-ai 和 DeepSeek catalog 投影、提供方／模型请求路由，以及提示词变量对齐；监听器安装在 agent 作用域的上下文中，因此能够实现 agent 间隔离。ACP 测试覆盖分组发现、无效和并发变更、拓扑更新、基于请求 header 的恢复、逐轮路由固定以及图片路由一致性；人工客户端测试自己的 selector 展示。
