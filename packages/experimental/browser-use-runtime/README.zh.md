---
description: "在实验性浏览器提供方之间共享按 Session 管理的浏览器所有权与 MCP 激活。"
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-browser-use-runtime

[English](README.md) | 中文

## 概述

浏览器提供方使用此库，在一个 Session 的多个轮次之间复用浏览器，并在该 Session 的运行时释放时关闭其资源。一个 Session 的操作按顺序运行，隔离的 Session 则可以独立推进。附加模式将一个外部浏览器保留给单个 Session。此库还连接提供方拥有的 MCP 服务器，并在 Session 首次模型请求前发现其工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

此公共实验性库是浏览器提供方的依赖。它没有插件入口或挂载配置。[浏览器操作服务](../../browser-use/browser-use/README.zh.md)保持独立于此库。

原生提供方从包根入口构造 `SessionResources`，提供资源获取与清理回调。调用向 `run()` 传递确切的实时 Agent；失效的所有者与独占附加的第二个所有者在获取资源前失败。取消资源获取等待不会终止初始化，同一 Session 的其他调用方仍可继续等待；释放 Session 会中止并等待该初始化结束。提供方将注册保留到 `dispose()` 完成。

MCP 提供方使用 `@deepseek-ai/dsh-experimental-browser-use-runtime/mcp` 中的 `mountSessionMcp`，提供固定服务器名称、可执行文件、参数与所有权策略。辅助库在每个后续 Agent 的 `agent/created` 事件中等待一次有作用域的客户端启动与发现尝试。Agent 创建或恢复在发现完成后结束，随后才运行排队输入；成功的客户端跨轮次归该 Session 所有。

附加连接被占用时，本次激活永久跳过启动，但其他工作继续运行。连接释放不会触发被跳过激活的重试；新创建或恢复的 Agent 可以获取连接。启动失败或取消会拒绝 Agent 创建或恢复，并触发包含客户端清理的创建回滚。重连已禁用。加载或重新加载提供方只作用于后续的 Agent 激活。

调用方在等待 Agent 创建或恢复完成后，即可检查提示词组装和作用域工具定义。

指向此服务器的浏览器工具调用与资源请求使用同一队列，且要求调用 Session 自己拥有连接。其他 MCP 服务器仍可使用。没有所有权时会省略继承的服务器指导；共享服务器名称目录保留常规作用域行为。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

[资源管理器](src/index.ts)以实时 Agent 身份为所有权键，并将操作取消与所有者释放关联起来。每个资源只有一个获取 promise 和一个操作队列。获取失败时，仅在提供方回调回滚已获取资源后释放保留。

因释放而取消时，在 AgentHandle 等待空闲前开始资源清理。清理先关闭资源再等待运行中的操作，使连接清理能够中断不支持 abort 的上游 API。关闭失败会拒绝释放并保留所有权。Agent 作用域清理防止使用同一持久 id 恢复的 Session 继承之前的浏览器。

[MCP 辅助库](src/mcp.ts)在串行 `agent/created` 中建立连接；[AgentLoop](../../core/agent-loop/README.zh.md#understand-the-implementation)保留排队输入并负责创建回滚。提示词组装读取已初始化的目录。辅助库在资源清理期间保留提供方注册，并通过 [MCP 客户端](../../mcp/mcp-client/README.zh.md)处理传输、schema 发现、结果转换与持久图像接纳。

不发布运行时不变量伴随入口：资源所有权与待处理工作是私有生命周期状态，没有可供比较的独立维护运行时投影。所属测试覆盖隔离、释放与清理失败。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [浏览器操作](../../../docs/subsystems/browser-use.zh.md) — 提供方选择与 Session 所有权。
- [MCP 客户端](../../mcp/mcp-client/README.zh.md) — 发现、取消与结果接纳。
- [浏览器所有权决策](../../../.agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.zh.md) — 仅注册名称的服务与资源生命周期。

-----

<a id="model-experience"></a>
## 模型体验

通过提供方拥有的浏览器工具间接影响模型，MCP 辅助库在模型请求组装前发现其目录；提供方与 MCP 客户端拥有描述、schema、结果与图像行为。

#### KV Cache 影响

此库不添加提示文本。发现的工具 schema 与提供方指导决定请求前缀变化；常规浏览器资源复用不改变这些 schema。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

提供方仍负责自己提供的浏览器操作。

- **MCP 激活** — 提供方不接管已有的活动 Agent；被占用的附加连接不会在本次激活中重试。
- **附加范围** — 独占所有权作用于一个资源管理器，不约束独立提供方、进程或外部浏览器客户端。
- **取消** — abort 信号与连接关闭无法撤销已交付的浏览器操作。同时忽略两者的上游操作可能延迟清理。
- **恢复** — 关闭失败会保留所有权；此管理器不重试释放，也不从 Session 日志恢复浏览器状态。
- **共享宿主运行时** — profile 会把本包与 dsh 安装并排安装，因此 `@deepseek-ai/dsh-scope` 与 `@deepseek-ai/dsh-mcp-client` 保持为 peer 依赖。写成 `dependencies` 会再装一份 `dsh-scope`，它的作用域标记宿主注册表读不到：每个 Agent 的 MCP 工具都会注册到全局工具层，第二个 Agent 的创建随之失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
